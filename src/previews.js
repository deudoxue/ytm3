import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  UserError,
  cookiesArgs,
  errorFromStderr,
  getFfmpegPath,
  getYtDlpPath,
  isVideoId,
} from './ytdlp.js';

const PREVIEW_SECONDS = 30;
const PREVIEW_TIMEOUT_MS = 75_000;

export class PreviewCache {
  constructor({ dir, maxConcurrent = 2, ttlMinutes = 30, maxEntries = 80 } = {}) {
    this.dir = dir ?? path.join(process.cwd(), 'tmp', 'previews');
    this.maxConcurrent = maxConcurrent;
    this.ttlMs = ttlMinutes * 60_000;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.queue = [];
    this.active = 0;
    this.children = new Set();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async init() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  get(videoId) {
    if (!isVideoId(videoId)) {
      throw new UserError('Video tidak valid.', 400);
    }

    const current = this.entries.get(videoId);
    if (current?.filePath) {
      current.lastUsed = Date.now();
      return Promise.resolve(current.filePath);
    }
    if (current?.promise) return current.promise;

    if (this.queue.length >= 30) {
      throw new UserError('Pratinjau sedang sibuk. Coba lagi sebentar.', 429);
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry = {
      videoId,
      status: 'queued',
      filePath: null,
      dir: null,
      child: null,
      promise,
      resolve,
      reject,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };

    this.entries.set(videoId, entry);
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  pump() {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (!entry) break;

      this.active += 1;
      this.generate(entry)
        .then((filePath) => {
          entry.status = 'ready';
          entry.filePath = filePath;
          entry.lastUsed = Date.now();
          entry.resolve(filePath);
          this.trim();
        })
        .catch((error) => {
          this.entries.delete(entry.videoId);
          entry.reject(error);
        })
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.pump();
        });
    }
  }

  async generate(entry) {
    const bin = getYtDlpPath();
    const ffmpeg = getFfmpegPath();
    if (!bin) {
      throw new UserError('yt-dlp tidak tersedia di server.', 503);
    }
    if (!ffmpeg) {
      throw new UserError('ffmpeg tidak tersedia di server.', 503);
    }

    const workDir = path.join(this.dir, entry.videoId);
    entry.dir = workDir;
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    try {
      const args = [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--socket-timeout',
        '20',
        '--retries',
        '2',
        '--match-filter',
        '!is_live',
        '--ffmpeg-location',
        ffmpeg,
        '--download-sections',
        `*0:00-0:${PREVIEW_SECONDS}`,
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '5',
        ...cookiesArgs(),
        '-o',
        path.join(workDir, 'preview.%(ext)s'),
        `https://www.youtube.com/watch?v=${entry.videoId}`,
      ];

      await this.run(entry, bin, args);
      const files = await readdir(workDir).catch(() => []);
      const mp3 = files.find((file) => file.toLowerCase().endsWith('.mp3'));
      if (!mp3) {
        throw new UserError('Pratinjau gagal dibuat. Coba lagi.', 502);
      }

      const filePath = path.join(workDir, mp3);
      const info = await stat(filePath);
      if (info.size < 1024) {
        throw new UserError('Pratinjau kosong. Coba lagi.', 502);
      }

      entry.child = null;
      return filePath;
    } catch (error) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof UserError) throw error;
      throw new UserError('Pratinjau gagal dibuat. Coba lagi.', 502);
    }
  }

  run(entry, bin, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });

      entry.child = child;
      this.children.add(child);

      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        this.children.delete(child);
        entry.child = null;
        if (error) reject(error);
        else resolve(stderr);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Process may have exited already.
        }
      }, PREVIEW_TIMEOUT_MS);

      const killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may have exited already.
        }
      }, PREVIEW_TIMEOUT_MS + 4_000);

      if (killTimer.unref) killTimer.unref();

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8192);
      });

      child.on('error', (error) => {
        finish(
          new UserError(
            error.code === 'ENOENT'
              ? 'yt-dlp tidak bisa dijalankan di server.'
              : 'Gagal menjalankan proses pratinjau.',
            503
          )
        );
      });

      child.on('close', (code, signal) => {
        if (timedOut) {
          finish(new UserError('Pratinjau terlalu lama diproses. Coba lagi.', 504));
          return;
        }
        if (code === 0) {
          finish(null);
          return;
        }
        console.error(
          `[ytmp3] pratinjau gagal (${entry.videoId}):\n${stderr.slice(-1500).trim()}`
        );
        finish(errorFromStderr(stderr, signal));
      });
    });
  }

  sweep() {
    const now = Date.now();
    for (const [videoId, entry] of [...this.entries.entries()]) {
      if (entry.status === 'ready' && now - entry.lastUsed > this.ttlMs) {
        this.remove(videoId);
      }
    }
    this.trim();
  }

  trim() {
    if (this.entries.size <= this.maxEntries) return;
    const finished = [...this.entries.entries()]
      .filter(([, entry]) => entry.status === 'ready')
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [videoId] of finished.slice(0, this.entries.size - this.maxEntries)) {
      this.remove(videoId);
    }
  }

  remove(videoId) {
    const entry = this.entries.get(videoId);
    if (!entry || entry.status !== 'ready') return;
    this.entries.delete(videoId);
    if (entry.dir) {
      rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }
    this.children.clear();
  }
}
