import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export const MAX_INPUT_LENGTH = 300;
export const MAX_DURATION_SECONDS =
  Number(process.env.MAX_DURATION_SECONDS) > 0
    ? Number(process.env.MAX_DURATION_SECONDS)
    : 3 * 60 * 60;

export class UserError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'UserError';
    this.statusCode = statusCode;
  }
}

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function getYtDlpPath() {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ].filter(Boolean);
  const bundled = candidates.find((candidate) => existsSync(candidate));
  return bundled ?? findOnPath(['yt-dlp', 'yt-dlp.exe']);
}

export function getFfmpegPath() {
  const candidates = [process.env.FFMPEG_PATH, ffmpegStatic].filter(Boolean);
  const bundled = candidates.find((candidate) => existsSync(candidate));
  return bundled ?? findOnPath(['ffmpeg', 'ffmpeg.exe']);
}

export function cookiesArgs() {
  const file = process.env.YTDLP_COOKIES;
  return file && existsSync(file) ? ['--cookies', file] : [];
}

export function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}

export function sanitizeText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function sanitizeFileName(value, fallback = 'audio') {
  const base = sanitizeText(value, 180)
    .replace(/\.(mp3|m4a|webm|opus|aac|wav)$/i, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return `${base || fallback}.mp3`;
}

export function parseYouTubeUrl(raw) {
  let candidate = String(raw).trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      id = match?.[1] ?? null;
    }
  }

  return id && VIDEO_ID_RE.test(id) ? id : null;
}

export function parseInput(raw) {
  if (typeof raw !== 'string') {
    throw new UserError('Masukkan tautan YouTube atau judul lagu.', 400);
  }

  const input = raw.replace(/\s+/g, ' ').trim();
  if (!input) throw new UserError('Masukkan tautan YouTube atau judul lagu.', 400);
  if (input.length > MAX_INPUT_LENGTH) {
    throw new UserError(`Teks terlalu panjang (maksimal ${MAX_INPUT_LENGTH} karakter).`, 400);
  }

  const looksLikeUrl =
    /^(https?:\/\/|www\.)/i.test(input) ||
    /(^|\.)(youtube\.com|youtu\.be)(\/|$)/i.test(input);

  if (looksLikeUrl) {
    const videoId = parseYouTubeUrl(input);
    if (videoId) return { kind: 'url', videoId };

    if (/[?&]list=|^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/playlist/i.test(input)) {
      throw new UserError('Playlist belum didukung. Buka satu video, lalu tempel tautannya.', 400);
    }
    throw new UserError(
      'Tautan YouTube tidak valid. Tempel tautan video, Shorts, atau youtu.be.',
      400
    );
  }

  return { kind: 'search', query: input };
}

function runYtDlp(args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    if (!bin) {
      reject(
        new UserError(
          'Server belum siap: yt-dlp tidak ditemukan. Jalankan "npm run setup".',
          503
        )
      );
      return;
    }

    const child = spawn(bin, ['--ignore-config', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      finish(new UserError('YouTube tidak merespons tepat waktu. Coba lagi.', 504));
      child.kill('SIGTERM');
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 12 * 1024 * 1024) {
        stdout = stdout.slice(-12 * 1024 * 1024);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });

    child.on('error', (err) => {
      finish(
        new UserError(
          err.code === 'ENOENT'
            ? 'yt-dlp tidak bisa dijalankan. Jalankan "npm run setup".'
            : 'Gagal menjalankan yt-dlp di server.',
          503
        )
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      finish(errorFromStderr(stderr, signal));
    });
  });
}

export function errorFromStderr(stderr, signal = null) {
  const text = String(stderr || '').toLowerCase();

  if (signal) {
    return new UserError('Proses dihentikan. Coba lagi.', 502);
  }
  if (text.includes('sign in to confirm') && text.includes('bot')) {
    return new UserError(
      'YouTube meminta verifikasi bot. Coba lagi beberapa menit lagi atau konfigurasi cookies di server.',
      422
    );
  }
  if (text.includes('age-restricted') || text.includes('confirm your age')) {
    return new UserError('Video ini dibatasi usia sehingga tidak bisa diunduh.', 422);
  }
  if (text.includes('private video')) {
    return new UserError('Video ini privat.', 422);
  }
  if (text.includes('http error 429') || text.includes('too many requests')) {
    return new UserError('YouTube membatasi permintaan. Tunggu sebentar lalu coba lagi.', 429);
  }
  if (text.includes('members-only') || text.includes('members only')) {
    return new UserError('Video ini khusus anggota channel.', 422);
  }
  if (text.includes('not available in your country') || text.includes('geo restricted')) {
    return new UserError('Video ini dibatasi di wilayah server.', 422);
  }
  if (text.includes('does not pass filter')) {
    return new UserError(
      'Video dilewati: kemungkinan live atau durasinya melebihi batas server.',
      422
    );
  }
  if (text.includes('video unavailable') || text.includes('this video is unavailable')) {
    return new UserError('Video tidak tersedia atau sudah dihapus.', 422);
  }
  if (text.includes('requested format is not available')) {
    return new UserError('Format audio video ini tidak tersedia. Coba video lain.', 422);
  }
  if (text.includes('http error 403') || text.includes('forbidden')) {
    const error = new UserError('YouTube menolak permintaan (403). Coba lagi beberapa saat.', 502);
    error.retryable = true;
    return error;
  }
  if (
    text.includes('getaddrinfo') ||
    text.includes('failed to resolve') ||
    text.includes('urlopen error') ||
    text.includes('timed out') ||
    text.includes('connection reset') ||
    text.includes('connection aborted') ||
    text.includes('network is unreachable') ||
    text.includes('temporary failure in name resolution')
  ) {
    const error = new UserError('Tidak bisa terhubung ke YouTube dari server. Coba lagi.', 502);
    error.retryable = true;
    return error;
  }
  if (text.includes('nsig extraction failed') || text.includes('unable to extract')) {
    return new UserError('yt-dlp gagal mengekstrak video. Perbarui yt-dlp di server.', 502);
  }
  if (text.includes('ffmpeg') && (text.includes('not found') || text.includes('not installed'))) {
    return new UserError('ffmpeg tidak tersedia di server.', 503);
  }

  return new UserError('Gagal memproses video. Coba video lain.', 422);
}

function normalizeVideo(info) {
  const id = String(info?.id ?? '');
  if (!isVideoId(id)) {
    throw new UserError('Video tidak ditemukan.', 422);
  }

  const duration = Number.isFinite(info.duration) ? Math.round(info.duration) : null;
  const liveStatus = String(info.live_status ?? '');

  return {
    videoId: id,
    title: sanitizeText(info.title || info.fulltitle, 200) || 'Tanpa judul',
    channel:
      sanitizeText(info.channel || info.uploader || info.artists?.join(', '), 120) || 'YouTube',
    duration,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    isLive: Boolean(info.is_live) || liveStatus === 'is_live' || liveStatus === 'is_upcoming',
  };
}

export async function fetchVideo(videoId) {
  if (!isVideoId(videoId)) {
    throw new UserError('ID video tidak valid.', 400);
  }

  const { stdout } = await runYtDlp(
    [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout',
      '15',
      ...cookiesArgs(),
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeoutMs: 45_000 }
  );

  let info;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new UserError('Gagal membaca data video dari YouTube. Coba lagi.', 502);
  }

  const video = normalizeVideo(info);
  if (video.isLive) {
    throw new UserError('Siaran langsung atau premiere tidak bisa diunduh.', 422);
  }
  if (video.duration && video.duration > MAX_DURATION_SECONDS) {
    const hours = Math.round((MAX_DURATION_SECONDS / 3600) * 10) / 10;
    throw new UserError(`Durasi video melebihi batas ${hours} jam.`, 422);
  }
  return video;
}

export async function searchVideos(query) {
  const { stdout } = await runYtDlp(
    [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--socket-timeout',
      '15',
      ...cookiesArgs(),
      `ytsearch8:${query}`,
    ],
    { timeoutMs: 45_000 }
  );

  let info;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new UserError('Gagal mencari lagu. Coba lagi.', 502);
  }

  const entries = Array.isArray(info?.entries) ? info.entries : [];
  return entries
    .filter((entry) => isVideoId(String(entry?.id ?? '')))
    .filter((entry) => {
      const liveStatus = String(entry.live_status ?? '');
      return !(entry.is_live || liveStatus === 'is_live' || liveStatus === 'is_upcoming');
    })
    .map((entry) => ({
      videoId: entry.id,
      title: sanitizeText(entry.title, 200) || 'Tanpa judul',
      channel: sanitizeText(entry.channel || entry.uploader, 120) || 'YouTube',
      duration: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
      thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
    }))
    .filter((video) => !(video.duration && video.duration > MAX_DURATION_SECONDS));
}
