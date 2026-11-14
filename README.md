# ytmp3

Website responsif untuk mengubah video YouTube menjadi MP3. Tempel tautan atau cari judul lagu, lalu simpan hasilnya dari browser — di HP, tablet, maupun laptop.

![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-3c873a) ![Express](https://img.shields.io/badge/Express-5-000) ![yt--dlp](https://img.shields.io/badge/yt--dlp-latest-ff6b4a)

## Fitur

- Pencarian judul lagu (8 hasil) atau tempel tautan YouTube, Shorts, `youtu.be`, dan `music.youtube.com`.
- Konversi audio ke MP3 dengan metadata dan cover art tertanam.
- Antrean unduhan dengan progres, pembatalan, dan tombol ulangi.
- Riwayat antrean di `localStorage`, jadi halaman bisa dimuat ulang tanpa kehilangan status.
- UI responsif: aman untuk notch/safe-area iOS, target sentuh ≥ 44px, dukungan keyboard dan `prefers-reduced-motion`.
- File siap diunduh dengan `Content-Disposition: attachment` sehingga tersimpan di folder unduhan perangkat.

## Kebutuhan

- Node.js 20 atau lebih baru.
- Koneksi internet ke YouTube.
- `ffmpeg` disediakan otomatis oleh paket `ffmpeg-static` (fallback ke `ffmpeg` di `PATH`).
- `yt-dlp` diunduh otomatis ke `bin/` saat `npm install` (macOS universal, Linux x64/arm64, Windows), dengan fallback ke `yt-dlp` di `PATH`.

## Menjalankan

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Untuk mengakses dari HP di jaringan yang sama, buka `http://<IP-LAN>:3000` (server listen di `0.0.0.0`). Pastikan firewall mengizinkan port 3000.

Mode pengembangan:

```bash
npm run dev
```

Perbarui yt-dlp bila YouTube mengubah sesuatu:

```bash
npm run update:ytdlp
```

## Konfigurasi

Semua konfigurasi lewat environment variable. Contoh:

```bash
PORT=8080 HOST=0.0.0.0 MAX_CONCURRENT=3 YTDLP_COOKIES=./cookies.txt npm start
```

| Variable | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP. |
| `HOST` | `0.0.0.0` | Bind address. |
| `TRUST_PROXY` | `0` | Set `1` bila di belakang reverse proxy agar rate limit memakai IP asli. |
| `TMP_DIR` | `./tmp` | Lokasi file sementara. |
| `MAX_CONCURRENT` | `2` | Unduhan yang diproses bersamaan (1–4). |
| `MAX_QUEUE` | `20` | Maksimum antrean per instance. |
| `JOB_TTL_MINUTES` | `45` | Umur file siap unduh sebelum dibersihkan (5–240). |
| `MAX_DURATION_SECONDS` | `10800` | Batas durasi video (3 jam) untuk membatasi bandwidth. |
| `YTDLP_PATH` | `./bin/yt-dlp` | Gunakan binary yt-dlp lain. |
| `FFMPEG_PATH` | dari `ffmpeg-static` | Gunakan ffmpeg sistem bila diinginkan. |
| `YTDLP_COOKIES` | – | Path file `cookies.txt` (format Netscape) untuk video yang butuh login/verifikasi. |

### Cookies (opsional)

Bila muncul pesan “YouTube meminta verifikasi bot”, ekspor cookies YouTube dari browser (ekstensi seperti “Get cookies.txt LOCALLY”), simpan sebagai `cookies.txt`, lalu jalankan:

```bash
YTDLP_COOKIES=./cookies.txt npm start
```

Cookies hanya diperlukan bila YouTube membatasi IP server. Perlakukan file ini seperti kredensial dan jangan commit ke git.

## Cara kerja

1. `POST /api/resolve` menjalankan `yt-dlp` untuk mengambil metadata atau hasil pencarian (`ytsearch8:`).
2. `POST /api/download` memasukkan video ke antrean in-memory. Maksimal `MAX_CONCURRENT` proses berjalan bersamaan.
3. Setiap proses menjalankan `yt-dlp -f bestaudio -x --audio-format mp3`, memakai ffmpeg untuk konversi, metadata, dan cover.
4. Klien mempolling `GET /api/jobs/:id` setiap ±1 detik; progres diambil dari `--progress-template` milik yt-dlp.
5. File jadi disajikan lewat `GET /api/jobs/:id/file` dengan nama file dari judul video.

File dan job disimpan di memori + `tmp/`. Setelah server restart atau TTL habis, file dihapus dan antrean lama tidak bisa diunduh lagi.

## Endpoint API

| Method | Path | Body / hasil |
| --- | --- | --- |
| `GET` | `/api/health` | Status yt-dlp, ffmpeg, dan antrean. |
| `POST` | `/api/resolve` | `{ "input": "url atau judul" }` → `{ kind: "video" \| "search", ... }`. |
| `POST` | `/api/download` | `{ videoId, title, channel, duration }` → job (HTTP 202). |
| `GET` | `/api/jobs/:id` | Status job. |
| `GET` | `/api/jobs/:id/file` | File MP3 (`attachment`). Hanya saat status `ready`. |
| `DELETE` | `/api/jobs/:id` | Batalkan job / hapus file. |

Batasan: playlist belum didukung, video live/premiere ditolak, dan video di atas `MAX_DURATION_SECONDS` ditolak. Rate limit: 20 resolve/menit dan 8 unduhan baru/menit per IP.

## Struktur

```
server.js               Express, keamanan header, rate limit, routing API
src/ytdlp.js            Lokasi binary, parsing URL, metadata, pencarian, pesan error
src/jobs.js             Antrean, proses yt-dlp/ffmpeg, progres, TTL, pembatalan
scripts/setup-binaries.js  Unduh binary yt-dlp sesuai platform
public/                 index.html, styles.css, app.js, ikon
tmp/                    File kerja (gitignored)
```

## Deployment

Aplikasi ini butuh proses Node yang bisa menjalankan `yt-dlp` dan `ffmpeg`; hosting statis (Vercel/Netlify/GitHub Pages) tidak cukup. Gunakan VPS/container yang mendukung long-running process. Contoh minimal di belakang Nginx:

```bash
HOST=127.0.0.1 PORT=3000 TRUST_PROXY=1 npm start
```

Karena tidak ada autentikasi bawaan, jangan ekspos langsung ke internet publik tanpa proxy/auth, firewall, dan kuota. Batasi juga `MAX_CONCURRENT`, `MAX_DURATION_SECONDS`, dan `JOB_TTL_MINUTES` sesuai kapasitas server.

## Troubleshooting

- **“YouTube meminta verifikasi bot”** — ekspor cookies dan jalankan dengan `YTDLP_COOKIES=./cookies.txt npm start`. Jangan commit file cookies.
- **“ffmpeg tidak tersedia”** — jalankan `node node_modules/ffmpeg-static/install.js`, pasang ffmpeg sistem lalu set `FFMPEG_PATH`, atau gunakan distro berbasis glibc (Alpine/musl butuh ffmpeg sistem).
- **Unduhan gagal karena 403/DNS/timeout** — server otomatis mencoba ulang sekali. Jika sering terjadi, perbarui yt-dlp dengan `npm run update:ytdlp` dan cek koneksi/DNS server.
- **Job atau file hilang** — antrean disimpan di memori; restart server menghapusnya. File juga dihapus setelah `JOB_TTL_MINUTES`.

## Catatan hukum

Gunakan hanya untuk konten yang kamu miliki haknya atau yang lisensinya mengizinkan unduhan. Mengunduh konten YouTube dapat melanggar Ketentuan Layanan YouTube dan hak cipta pemilik konten. Proyek ini tidak berafiliasi dengan YouTube.
