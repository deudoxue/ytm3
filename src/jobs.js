import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  MAX_DURATION_SECONDS,
  UserError,
  cookiesArgs,
  errorFromStderr,
  getFfmpegPath,
  getYtDlpPath,
  isVideoId,
  sanitizeFileName,
  sanitizeText,
} from './ytdlp.js';

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'converting']);
const PROGRESS_PREFIX = '@@P|';

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function wireLines(stream, onLine) {
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
    if (buffer.length > 8192) buffer = buffer.slice(-8192);
  });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function findMp3(dir) {
  const entries = await readdir(dir).catch(() => []);
  const mp3 = entries.find((entry) => entry.toLowerCase().endsWith('.mp3'));
  return mp3 ? path.join(dir, mp3) : null;
}

export class JobStore {
  constructor({ dir, ttlMinutes, maxConcurrent, maxQueue } = {}) {
    this.dir = dir ?? path.join(process.cwd(), 'tmp');
    this.ttlMs = (ttlMinutes ?? envInt('JOB_TTL_MINUTES', 45, 5, 240)) * 60_000;
    this.maxConcurrent = maxConcurrent ?? envInt('MAX_CONCURRENT', 2, 1, 4);
    this.maxQueue = maxQueue ?? envInt('MAX_QUEUE', 20, 1, 100);
    this.ffmpegPath = getFfmpegPath();
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  enqueue(video) {
    if (!isVideoId(video?.videoId)) {
      throw new UserError('ID video tidak valid.', 400);
    }
    if (this.queue.length >= this.maxQueue) {
      throw new UserError('Antrean sedang penuh. Coba lagi sebentar lagi.', 429);
    }

    const now = Date.now();
    const job = {
      id: randomUUID(),
      videoId: video.videoId,
      title: sanitizeText(video.title, 200) || `YouTube ${video.videoId}`,
      channel: sanitizeText(video.channel, 120) || 'YouTube',
      duration: Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration)) : null,
      thumbnail: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
      status: 'queued',
      progress: 0,
      stage: 'Menunggu antrean…',
      error: null,
      fileName: null,
      filePath: null,
      sizeBytes: null,
      dir: null,
      child: null,
      cancelled: false,
      finished: false,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return this.toPublic(job);
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  toPublic(job) {
    return {
      id: job.id,
      videoId: job.videoId,
      title: job.title,
      channel: job.channel,
      duration: job.duration,
      thumbnail: job.thumbnail,
      status: job.status,
      progress: Math.round(job.progress),
      stage: job.stage,
      error: job.error,
      fileName: job.fileName,
      sizeBytes: job.sizeBytes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      downloadUrl: job.status === 'ready' ? `/api/jobs/${job.id}/file` : null,
    };
  }

  pump() {
    while (this.active < this.maxConcurrent) {
      const job = this.queue.shift();
      if (!job) break;
      this.run(job);
    }
  }

  run(job) {
    this.active += 1;

    const finish = async (error) => {
      if (job.finished) return;
      job.finished = true;
      job.child = null;
      job.updatedAt = Date.now();

      let failure = error;
      if (!failure) {
        try {
          const file = await findMp3(job.dir);
          if (!file) throw new Error('missing mp3');
          const info = await stat(file);
          job.filePath = file;
          job.fileName = sanitizeFileName(job.title);
          job.sizeBytes = info.size;
        } catch {
          failure = new UserError('Konversi selesai, tetapi file MP3 tidak ditemukan.', 502);
        }
      }

      const isCurrent = this.jobs.get(job.id) === job;
      if (failure) {
        if (isCurrent) {
          job.status = 'error';
          job.error = failure.message || 'Gagal memproses audio.';
          job.stage = 'Gagal';
        }
        if (job.dir) await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      } else if (isCurrent) {
        job.status = 'ready';
        job.stage = 'Siap diunduh';
        job.progress = 100;
      } else if (job.dir) {
        await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }

      this.active = Math.max(0, this.active - 1);
      this.pump();
    };

    this.setup(job, finish).catch((error) => finish(error));
  }

  async setup(job, finish) {
    job.status = 'downloading';
    job.stage = 'Menyiapkan unduhan…';
    job.updatedAt = Date.now();

    const jobDir = path.join(this.dir, job.id);
    job.dir = jobDir;
    await mkdir(jobDir, { recursive: true });

    if (job.cancelled) {
      await finish(new UserError('Dibatalkan.', 499));
      return;
    }

    const bin = getYtDlpPath();
    if (!bin) {
      await finish(
        new UserError('yt-dlp tidak ditemukan di server. Jalankan "npm run setup".', 503)
      );
      return;
    }
    if (!this.ffmpegPath) {
      await finish(new UserError('ffmpeg tidak tersedia di server.', 503));
      return;
    }

    const args = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress-delta',
      '0.5',
      '--socket-timeout',
      '30',
      '--retries',
      '3',
      '--extractor-retries',
      '2',
      '--fragment-retries',
      '3',
      ...cookiesArgs(),
      '--max-filesize',
      '300M',
      '--match-filter',
      `!is_live & duration <= ${MAX_DURATION_SECONDS}`,
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--ffmpeg-location',
      this.ffmpegPath,
      '--progress-template',
      `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
      '-o',
      path.join(jobDir, 'audio.%(ext)s'),
      `https://www.youtube.com/watch?v=${job.videoId}`,
    ];

    let attempt = 1;
    const maxAttempts = 2;

    const startAttempt = () => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
      job.child = child;

      let stderrTail = '';
      let settled = false;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        job.child = null;
        if (!error) {
          finish(null);
          return;
        }
        handleFailure(error);
      };

      const handleFailure = async (error) => {
        if (job.cancelled) {
          await finish(new UserError('Dibatalkan.', 499));
          return;
        }

        if (error.retryable && attempt < maxAttempts) {
          attempt += 1;
          job.status = 'downloading';
          job.progress = 0;
          job.stage = 'Mencoba ulang otomatis…';
          job.updatedAt = Date.now();
          console.warn(
            `[ytmp3] mencoba ulang ${job.videoId} (${attempt}/${maxAttempts}): ${error.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, 1200));
          if (job.cancelled) {
            await finish(new UserError('Dibatalkan.', 499));
            return;
          }
          startAttempt();
          return;
        }

        await finish(error);
      };

      const handleLine = (line) => {
        if (job.cancelled) return;

        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, estimate] = line
            .slice(PROGRESS_PREFIX.length)
            .split('|');
          const totalBytes = toNumber(total) || toNumber(estimate);
          const downloadedBytes = toNumber(downloaded);
          if (totalBytes > 0) {
            const percent = Math.round((downloadedBytes / totalBytes) * 100);
            job.progress = Math.max(job.progress, Math.min(99, Math.max(0, percent)));
            if (job.status === 'downloading') job.stage = 'Mengunduh audio…';
            job.updatedAt = Date.now();
          }
          return;
        }

        if (
          line.startsWith('[ExtractAudio]') ||
          line.startsWith('[Metadata]') ||
          line.startsWith('[EmbedThumbnail]') ||
          line.startsWith('[ThumbnailsConvertor]')
        ) {
          if (job.status === 'downloading') {
            job.status = 'converting';
            job.stage = 'Mengubah ke MP3…';
            job.progress = 99;
            job.updatedAt = Date.now();
          }
        }
      };

      wireLines(child.stdout, handleLine);
      wireLines(child.stderr, (line) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-8192);
        handleLine(line);
      });

      child.on('error', (error) => {
        settle(
          new UserError(
            error.code === 'ENOENT'
              ? 'yt-dlp tidak bisa dijalankan di server.'
              : 'Gagal menjalankan proses unduhan.',
            503
          )
        );
      });

      child.on('close', (code, signal) => {
        if (job.cancelled) {
          settle(new UserError('Dibatalkan.', 499));
          return;
        }
        if (code !== 0) {
          console.error(
            `[ytmp3] unduhan gagal (${job.videoId}):\n${stderrTail.slice(-2000).trim()}`
          );
          settle(errorFromStderr(stderrTail, signal));
          return;
        }
        settle(null);
      });
    };

    startAttempt();
  }

  delete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.cancelled = true;
    this.jobs.delete(id);
    this.queue = this.queue.filter((item) => item !== job);

    if (job.child) {
      const child = job.child;
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may have already exited.
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may have already exited.
        }
      }, 4000);
      timer.unref();
    }

    if (job.dir) {
      rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }

    this.pump();
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      if (!ACTIVE_STATUSES.has(job.status) && now - job.updatedAt > this.ttlMs) {
        this.delete(job.id);
      }
    }

    if (this.jobs.size > 100) {
      const finished = [...this.jobs.values()]
        .filter((job) => !ACTIVE_STATUSES.has(job.status))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      for (const job of finished.slice(0, this.jobs.size - 100)) {
        this.delete(job.id);
      }
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const job of this.jobs.values()) {
      if (job.child) {
        try {
          job.child.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      }
    }
  }
}
