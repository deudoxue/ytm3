const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  form: $('#search-form'),
  input: $('#query'),
  searchBtn: $('#search-btn'),
  searchLabel: $('#search-label'),
  note: $('#form-note'),
  chips: $$('.chip'),
  results: $('#results'),
  resultsTitle: $('#results-title'),
  resultsSub: $('#results-sub'),
  resultsBody: $('#results-body'),
  resultsClose: $('#results-close'),
  downloads: $('#downloads'),
  jobList: $('#job-list'),
  jobCount: $('#job-count'),
  toasts: $('#toasts'),
  year: $('#year'),
};

const templates = {
  track: $('#tpl-track'),
  job: $('#tpl-job'),
};

const HINT = 'Tempel tautan video, Shorts, atau tautan youtu.be.';
const STORAGE_KEY = 'ytmp3.jobs.v1';
const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'converting']);
const JOB_STATUSES = ['queued', 'downloading', 'converting', 'ready', 'error'];

const state = {
  busy: false,
  jobs: new Map(),
  jobRefs: new Map(),
  pollTimer: null,
  polling: false,
};

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToElement(element, block = 'start') {
  if (!element) return;
  element.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block,
  });
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'MP3';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    const error = new Error('Tidak bisa terhubung ke server. Periksa koneksimu.');
    error.status = 0;
    throw error;
  }

  if (response.status === 204) return null;

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(data?.error || `Permintaan gagal (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setNote(message, isError = false) {
  elements.note.textContent = message;
  elements.note.classList.toggle('is-error', isError);
}

function updateSearchMode() {
  const looksLikeUrl = /(youtube\.com|youtu\.be)/i.test(elements.input.value);
  elements.searchLabel.textContent = looksLikeUrl ? 'Ambil' : 'Cari';
  elements.searchBtn.setAttribute('aria-label', looksLikeUrl ? 'Ambil info video' : 'Cari lagu');
}

function toast(message, type = 'info') {
  if (!message) return;

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;

  const dot = document.createElement('span');
  dot.className = 'toast__dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.textContent = message;

  node.append(dot, text);
  elements.toasts.append(node);

  while (elements.toasts.children.length > 3) {
    elements.toasts.firstElementChild.remove();
  }

  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

function renderSkeletons() {
  elements.resultsBody.className = 'tracks';
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 4; index += 1) {
    const card = document.createElement('div');
    card.className = 'track track--skeleton';
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML =
      '<div class="sk sk--media"></div><div class="sk sk--line"></div>' +
      '<div class="sk sk--line sk--short"></div><div class="sk sk--btn"></div>';
    fragment.append(card);
  }
  elements.resultsBody.replaceChildren(fragment);
}

function renderEmpty({ title, text, retry = false }) {
  const box = document.createElement('div');
  box.className = 'empty';

  const heading = document.createElement('p');
  heading.className = 'empty__title';
  heading.textContent = title;

  const copy = document.createElement('p');
  copy.className = 'empty__text';
  copy.textContent = text;

  box.append(heading, copy);

  if (retry) {
    const actions = document.createElement('div');
    actions.className = 'empty__actions';
    const button = document.createElement('button');
    button.className = 'btn btn--primary';
    button.type = 'button';
    button.textContent = 'Coba lagi';
    button.addEventListener('click', () => elements.form.requestSubmit());
    actions.append(button);
    box.append(actions);
  }

  elements.resultsBody.replaceChildren(box);
}

function buildTrack(video, { featured = false } = {}) {
  const node = templates.track.content.firstElementChild.cloneNode(true);
  if (featured) node.classList.add('track--featured');

  const image = $('.track__img', node);
  image.src = video.thumbnail;
  image.addEventListener(
    'error',
    () => {
      node.classList.add('is-noimg');
    },
    { once: true }
  );

  $('.track__duration', node).textContent = formatDuration(video.duration);
  $('.track__title', node).textContent = video.title || 'Tanpa judul';
  $('.track__channel', node).textContent = video.channel || 'YouTube';

  const button = $('.btn--track', node);
  button.setAttribute('aria-label', `Unduh MP3: ${video.title || 'video'}`);
  button.addEventListener('click', () => startDownload(video, button));

  return node;
}

function renderResults(data) {
  if (data.kind === 'video') {
    elements.resultsTitle.textContent = 'Siap diunduh';
    elements.resultsSub.textContent = 'Audio akan dikonversi ke MP3 kualitas terbaik.';
    elements.resultsBody.className = '';
    elements.resultsBody.replaceChildren(buildTrack(data.video, { featured: true }));
    return;
  }

  const results = Array.isArray(data.results) ? data.results : [];
  elements.resultsTitle.textContent = 'Hasil pencarian';
  elements.resultsBody.className = 'tracks';
  elements.resultsSub.textContent = results.length
    ? `${results.length} lagu untuk “${data.query}”`
    : `Tidak ada hasil untuk “${data.query}”`;

  if (!results.length) {
    renderEmpty({
      title: 'Lagu tidak ditemukan',
      text: 'Coba kata kunci lain, atau tempel tautan YouTube langsung.',
    });
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const video of results) {
    fragment.append(buildTrack(video));
  }
  elements.resultsBody.replaceChildren(fragment);
}

function renderSearchError(message) {
  elements.results.hidden = false;
  elements.resultsTitle.textContent = 'Gagal memproses';
  elements.resultsSub.textContent = 'Periksa tautan atau coba beberapa saat lagi.';
  elements.resultsBody.className = '';
  renderEmpty({
    title: 'Permintaan tidak berhasil',
    text: message,
    retry: true,
  });
}

function existingJobFor(videoId) {
  for (const job of state.jobs.values()) {
    if (job.videoId === videoId && (isActiveStatus(job.status) || job.status === 'ready')) {
      return job;
    }
  }
  return null;
}

async function startDownload(video, button = null) {
  if (!video?.videoId) return;

  const existing = existingJobFor(video.videoId);
  if (existing) {
    focusJob(existing.id);
    toast(
      existing.status === 'ready'
        ? 'Lagu ini sudah siap disimpan.'
        : 'Lagu ini sudah ada di antrean.',
      'info'
    );
    return;
  }

  if (button) {
    button.disabled = true;
    button.classList.add('is-busy');
  }

  try {
    const job = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        videoId: video.videoId,
        title: video.title,
        channel: video.channel,
        duration: video.duration,
      }),
    });
    addJob(job);
    toast('Masuk antrean. Proses otomatis dimulai.', 'success');
    scrollToElement(elements.downloads, 'start');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  }
}

function focusJob(id) {
  const refs = state.jobRefs.get(id);
  if (!refs) {
    scrollToElement(elements.downloads, 'start');
    return;
  }
  elements.downloads.hidden = false;
  scrollToElement(refs.row, 'center');
  refs.row.classList.remove('job--flash');
  void refs.row.offsetWidth;
  refs.row.classList.add('job--flash');
  setTimeout(() => refs.row.classList.remove('job--flash'), 1400);
}

function createJobRow(job) {
  const row = templates.job.content.firstElementChild.cloneNode(true);
  const refs = {
    row,
    image: $('.job__thumb', row),
    title: $('.job__title', row),
    meta: $('.job__meta', row),
    pct: $('.job__pct', row),
    progress: $('.progress', row),
    bar: $('.progress__bar', row),
    status: $('.job__status', row),
    save: $('.job__save', row),
    retry: $('.job__retry', row),
    remove: $('.job__remove', row),
  };

  refs.image.addEventListener(
    'error',
    () => {
      refs.image.hidden = true;
    },
    { once: true }
  );

  refs.remove.addEventListener('click', () => removeJob(job.id));
  refs.retry.addEventListener('click', () => retryJob(job.id));

  state.jobRefs.set(job.id, refs);
  elements.jobList.append(row);
}

function renderJob(job) {
  const refs = state.jobRefs.get(job.id);
  if (!refs) return;

  for (const status of JOB_STATUSES) {
    refs.row.classList.toggle(`job--${status}`, job.status === status);
  }

  refs.title.textContent = job.title || 'Tanpa judul';
  refs.meta.textContent = [job.channel, job.duration ? formatDuration(job.duration) : null]
    .filter(Boolean)
    .join(' · ');
  if (refs.image.dataset.src !== job.thumbnail) {
    refs.image.dataset.src = job.thumbnail;
    refs.image.src = job.thumbnail;
  }

  const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const indeterminate =
    job.status === 'queued' || (job.status === 'downloading' && percent === 0);
  const barPercent = job.status === 'converting' ? 99 : percent;

  refs.progress.hidden = job.status === 'error';
  refs.progress.classList.toggle('is-indeterminate', indeterminate);
  refs.bar.style.width = `${barPercent}%`;

  if (indeterminate) {
    refs.progress.removeAttribute('aria-valuenow');
    refs.progress.setAttribute('aria-valuetext', 'Sedang diproses');
  } else {
    refs.progress.setAttribute('aria-valuenow', String(barPercent));
    refs.progress.removeAttribute('aria-valuetext');
  }

  if (job.status === 'queued') {
    refs.pct.textContent = 'Antrean';
    refs.status.textContent = job.stage || 'Menunggu antrean…';
  } else if (job.status === 'downloading') {
    refs.pct.textContent = percent > 0 ? `${percent}%` : '';
    refs.status.textContent = percent > 0 ? `Mengunduh audio · ${percent}%` : job.stage || 'Menyiapkan unduhan…';
  } else if (job.status === 'converting') {
    refs.pct.textContent = 'MP3';
    refs.status.textContent = 'Mengubah ke MP3…';
  } else if (job.status === 'ready') {
    refs.pct.textContent = formatBytes(job.sizeBytes);
    refs.status.textContent = 'Siap disimpan';
  } else {
    refs.pct.textContent = '';
    refs.status.textContent = job.error || 'Unduhan gagal.';
  }

  const active = isActiveStatus(job.status);
  refs.save.hidden = job.status !== 'ready';
  if (job.status === 'ready') {
    refs.save.href = job.downloadUrl || `/api/jobs/${job.id}/file`;
    refs.save.setAttribute('download', job.fileName || 'audio.mp3');
  }
  refs.retry.hidden = job.status !== 'error';
  refs.remove.textContent = active ? 'Batal' : 'Hapus';
}

function updateJobCount() {
  elements.jobCount.textContent = String(state.jobs.size);
}

function persistJobs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.jobs.keys()]));
  } catch {
    // Storage can be blocked in private mode; jobs still work for this session.
  }
}

function addJob(job) {
  const previous = state.jobs.get(job.id);
  state.jobs.set(job.id, job);

  if (!state.jobRefs.has(job.id)) createJobRow(job);
  renderJob(job);

  elements.downloads.hidden = false;
  updateJobCount();
  persistJobs();

  if (previous && previous.status !== job.status) {
    if (job.status === 'ready') {
      toast('MP3 siap disimpan.', 'success');
    } else if (job.status === 'error') {
      toast(job.error || 'Unduhan gagal.', 'error');
    }
  }

  if (isActiveStatus(job.status)) startPolling();
}

function removeJobLocal(id) {
  state.jobs.delete(id);
  const refs = state.jobRefs.get(id);
  if (refs) {
    refs.row.remove();
    state.jobRefs.delete(id);
  }

  persistJobs();
  updateJobCount();

  if (!state.jobs.size) {
    elements.downloads.hidden = true;
  }

  if (![...state.jobs.values()].some((job) => isActiveStatus(job.status))) {
    stopPolling();
  }
}

async function removeJob(id) {
  const job = state.jobs.get(id);
  if (!job) return;

  const wasActive = isActiveStatus(job.status);
  removeJobLocal(id);

  try {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
  } catch {
    // The server may have already cleaned it up.
  }

  if (wasActive) toast('Unduhan dibatalkan.', 'info');
}

async function retryJob(id) {
  const job = state.jobs.get(id);
  if (!job) return;

  const video = {
    videoId: job.videoId,
    title: job.title,
    channel: job.channel,
    duration: job.duration,
  };

  await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  removeJobLocal(id);
  await startDownload(video);
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(pollJobs, 1100);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollJobs() {
  if (state.polling) return;

  const activeIds = [...state.jobs.values()]
    .filter((job) => isActiveStatus(job.status))
    .map((job) => job.id);

  if (!activeIds.length) {
    stopPolling();
    return;
  }

  state.polling = true;
  await Promise.allSettled(
    activeIds.map(async (id) => {
      try {
        const job = await api(`/api/jobs/${id}`);
        if (!state.jobs.has(id)) return;
        addJob(job);
      } catch (error) {
        if (error.status === 404 && state.jobs.has(id)) {
          removeJobLocal(id);
          toast('Unduhan kedaluwarsa. Silakan mulai lagi.', 'error');
        }
      }
    })
  );
  state.polling = false;

  if (![...state.jobs.values()].some((job) => isActiveStatus(job.status))) {
    stopPolling();
  }
}

function storedJobIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((id) => typeof id === 'string').slice(0, 20);
  } catch {
    return [];
  }
}

async function hydrateJobs() {
  const ids = storedJobIds();
  if (!ids.length) return;

  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const job = await api(`/api/jobs/${id}`);
        addJob(job);
      } catch {
        // Missing and expired jobs are dropped from local storage below.
      }
    })
  );

  persistJobs();
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = elements.input.value.trim();
  if (!input) {
    setNote('Masukkan tautan atau judul lagu.', true);
    elements.input.focus();
    return;
  }
  if (state.busy) return;

  state.busy = true;
  elements.searchBtn.disabled = true;
  setNote('Menghubungi YouTube…');
  elements.results.hidden = false;
  elements.results.setAttribute('aria-busy', 'true');
  elements.resultsTitle.textContent = 'Mencari';
  elements.resultsSub.textContent = 'Memproses permintaan…';
  renderSkeletons();
  scrollToElement(elements.results, 'start');

  try {
    const data = await api('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    renderResults(data);
  } catch (error) {
    renderSearchError(error.message);
  } finally {
    state.busy = false;
    elements.searchBtn.disabled = false;
    elements.results.setAttribute('aria-busy', 'false');
    setNote(HINT);
  }
});

elements.input.addEventListener('input', updateSearchMode);

for (const chip of elements.chips) {
  chip.addEventListener('click', () => {
    if (state.busy) return;
    elements.input.value = chip.dataset.query || chip.textContent.trim();
    updateSearchMode();
    elements.form.requestSubmit();
  });
}

elements.resultsClose.addEventListener('click', () => {
  elements.results.hidden = true;
  elements.resultsBody.replaceChildren();
  setNote(HINT);
});

if (elements.year) {
  elements.year.textContent = String(new Date().getFullYear());
}

updateSearchMode();
hydrateJobs();
