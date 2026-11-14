import path from 'node:path';
import process from 'node:process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { JobStore } from './src/jobs.js';
import { PreviewCache } from './src/previews.js';
import {
  MAX_INPUT_LENGTH,
  UserError,
  fetchVideo,
  getFfmpegPath,
  getYtDlpPath,
  isVideoId,
  parseInput,
  searchVideos,
} from './src/ytdlp.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TMP_DIR = path.resolve(process.env.TMP_DIR || path.join(ROOT, 'tmp'));

await mkdir(TMP_DIR, { recursive: true });
const staleEntries = await readdir(TMP_DIR).catch(() => []);
await Promise.all(
  staleEntries
    .filter((entry) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry))
    .map((entry) => rm(path.join(TMP_DIR, entry), { recursive: true, force: true }).catch(() => {}))
);

const app = express();
const store = new JobStore({ dir: TMP_DIR });
const previews = new PreviewCache({ dir: path.join(TMP_DIR, 'previews') });
await previews.init();
let activeResolves = 0;

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' https://i.ytimg.com data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "media-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '8kb' }));

function makeLimiter({ max, windowMs }) {
  const buckets = new Map();
  const pruner = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000);
  pruner.unref();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
      return;
    }
    next();
  };
}

const resolveLimiter = makeLimiter({ max: 20, windowMs: 60_000 });
const downloadLimiter = makeLimiter({ max: 8, windowMs: 60_000 });
const previewLimiter = makeLimiter({ max: 120, windowMs: 60_000 });

app.use(
  express.static(path.join(ROOT, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ytdlp: Boolean(getYtDlpPath()),
    ffmpeg: Boolean(getFfmpegPath()),
    activeJobs: store.active,
    queuedJobs: store.queue.length,
    activePreviews: previews.active,
    cachedPreviews: previews.entries.size,
  });
});

app.post('/api/resolve', resolveLimiter, async (req, res) => {
  if (activeResolves >= 6) {
    throw new UserError('Server sedang sibuk. Coba lagi sebentar.', 429);
  }

  const input = req.body?.input;
  if (typeof input === 'string' && input.length > MAX_INPUT_LENGTH) {
    throw new UserError(`Teks terlalu panjang (maksimal ${MAX_INPUT_LENGTH} karakter).`, 400);
  }

  activeResolves += 1;
  try {
    const parsed = parseInput(input);
    if (parsed.kind === 'url') {
      const video = await fetchVideo(parsed.videoId);
      res.json({ kind: 'video', video });
      return;
    }

    const results = await searchVideos(parsed.query);
    res.json({ kind: 'search', query: parsed.query, results });
  } finally {
    activeResolves -= 1;
  }
});

app.post('/api/download', downloadLimiter, (req, res) => {
  const { videoId, title, channel, duration } = req.body ?? {};
  if (!isVideoId(videoId)) {
    throw new UserError('Video tidak valid.', 400);
  }

  const job = store.enqueue({
    videoId,
    title,
    channel,
    duration: Number(duration),
  });
  res.status(202).json(job);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Unduhan tidak ditemukan atau sudah kedaluwarsa.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(store.toPublic(job));
});

app.get('/api/jobs/:id/file', (req, res, next) => {
  const job = store.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
    return;
  }
  if (job.status !== 'ready' || !job.filePath) {
    res.status(409).json({ error: 'File belum siap.' });
    return;
  }

  res.setHeader('Cache-Control', 'private, no-store');
  res.download(job.filePath, job.fileName || 'audio.mp3', (error) => {
    if (!error) return;
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    next(error);
  });
});

app.get('/api/previews/:videoId', previewLimiter, async (req, res, next) => {
  const filePath = await previews.get(req.params.videoId);
  if (res.destroyed) return;

  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.sendFile(filePath, (error) => {
    if (!error) return;
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    next(error);
  });
});

app.delete('/api/jobs/:id', (req, res) => {
  store.delete(req.params.id);
  res.status(204).end();
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const statusCode =
    error instanceof UserError ? error.statusCode : Number(error.status) || 500;
  if (statusCode >= 500) {
    console.error('[ytmp3]', error);
  }
  res.status(statusCode).json({
    error:
      statusCode >= 500 && !(error instanceof UserError)
        ? 'Terjadi kesalahan pada server.'
        : error.message || 'Terjadi kesalahan.',
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ytmp3 berjalan di http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`Akses dari perangkat lain: http://<IP-LAN>:${PORT}`);
  }
  if (!getYtDlpPath()) console.warn('[ytmp3] yt-dlp belum tersedia — jalankan "npm run setup".');
  if (!getFfmpegPath()) console.warn('[ytmp3] ffmpeg belum tersedia — konversi MP3 akan gagal.');
});

function shutdown() {
  store.shutdown();
  previews.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
