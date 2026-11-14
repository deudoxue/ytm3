#!/usr/bin/env node
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN_DIR = path.join(ROOT, 'bin');
const isWindows = process.platform === 'win32';
const force = process.argv.includes('--force');
const target = path.join(BIN_DIR, isWindows ? 'yt-dlp.exe' : 'yt-dlp');

if (process.env.YTDLP_PATH && existsSync(process.env.YTDLP_PATH)) {
  console.log(`[setup] memakai yt-dlp dari YTDLP_PATH: ${process.env.YTDLP_PATH}`);
  process.exit(0);
}

if (existsSync(target) && !force) {
  console.log('[setup] yt-dlp sudah tersedia, lewati unduhan.');
  process.exit(0);
}

function assetName() {
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (isWindows) return 'yt-dlp.exe';
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
    if (process.arch === 'x64') return 'yt-dlp_linux';
  }
  return null;
}

const asset = assetName();
if (!asset) {
  console.error(`[setup] Platform ${process.platform}/${process.arch} belum didukung oleh installer.`);
  console.error('[setup] Pasang yt-dlp manual lalu set YTDLP_PATH=/path/ke/yt-dlp.');
  process.exit(1);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
const tmp = `${target}.download`;

console.log(`[setup] mengunduh ${asset}…`);
mkdirSync(BIN_DIR, { recursive: true });

try {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (!isWindows) chmodSync(tmp, 0o755);
  rmSync(target, { force: true });
  renameSync(tmp, target);
  console.log(`[setup] siap: ${target}`);
} catch (err) {
  rmSync(tmp, { force: true });
  console.error(`[setup] gagal mengunduh yt-dlp: ${err.message}`);
  console.error('[setup] Alternatif: pip install -U yt-dlp lalu jalankan dengan YTDLP_PATH=$(which yt-dlp) npm start');
  process.exit(1);
}
