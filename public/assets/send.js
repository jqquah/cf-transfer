import { crc32Update } from './crc32.js';

const PART = 50 * 1024 * 1024; // must match src/index.js PART_SIZE
const MAX_REQ = 4; // parallel upload requests
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const H = { 'X-Requested-With': 'transfer' };
const $ = (id) => document.getElementById(id);

let queue = []; // { file, path }
let active = null; // current upload job

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtLeft = (ms) => {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
};

async function api(path, opts = {}) {
  const res = await fetch(`/api/send${path}`, { ...opts, headers: { ...H, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- picking and dropping ---------- */

function addFiles(list) {
  for (const { file, path } of list) {
    const name = path.split('/').pop();
    if (SKIP.has(name)) continue;
    queue.push({ file, path });
  }
  renderQueue();
}

function readAllEntries(dirEntry) {
  const reader = dirEntry.createReader();
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next(); // readEntries returns at most 100 entries per call
    }, reject);
    next();
  });
}

async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry)) await walk(child, out);
  }
}

async function onDrop(e) {
  e.preventDefault();
  $('dropzone').hidden = true;
  if (active || !$('done').hidden) return;
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  const out = [];
  if (entries.length && entries.every(Boolean)) {
    for (const en of entries) await walk(en, out);
  } else {
    for (const f of e.dataTransfer.files) out.push({ file: f, path: f.name });
  }
  addFiles(out);
}

function renderQueue() {
  const ul = $('queueList');
  ul.textContent = '';
  const groups = new Map();
  for (const q of queue) {
    const top = q.path.includes('/') ? q.path.split('/')[0] + '/' : q.path;
    const g = groups.get(top) || { n: 0, size: 0, folder: q.path.includes('/') };
    g.n++; g.size += q.file.size;
    groups.set(top, g);
  }
  for (const [name, g] of groups) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'qname';
    label.textContent = g.folder ? `${name.slice(0, -1)}` : name;
    const meta = document.createElement('span');
    meta.className = 'qmeta';
    meta.textContent = g.folder ? `Folder, ${g.n} file${g.n === 1 ? '' : 's'}, ${fmtSize(g.size)}` : fmtSize(g.size);
    const x = document.createElement('button');
    x.className = 'x'; x.type = 'button'; x.title = 'Remove'; x.textContent = '×';
    x.onclick = () => { queue = queue.filter((q) => (g.folder ? !q.path.startsWith(name) : q.path !== name)); renderQueue(); };
    li.append(label, meta, x);
    ul.append(li);
  }
  const total = queue.reduce((a, q) => a + q.file.size, 0);
  $('queue').hidden = queue.length === 0;
  $('queueSum').textContent = `${queue.length} file${queue.length === 1 ? '' : 's'}, ${fmtSize(total)}`;
  $('go').disabled = queue.length === 0;
}

/* ---------- uploading ---------- */

function xhrPut(url, body, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    for (const [k, v] of Object.entries(H)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let data = {};
      try { data = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `Upload failed (${x.status})`), { status: x.status }));
    };
    x.onerror = () => reject(new Error('Network error'));
    x.onabort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

async function withRetry(fn, signal) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      if (signal.aborted || i >= 4 || (err.status && err.status < 500 && err.status !== 429)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

class Slots {
  constructor(n) { this.free = n; this.waiters = []; }
  async take() { if (this.free > 0) { this.free--; return; } await new Promise((r) => this.waiters.push(r)); }
  give() { const w = this.waiters.shift(); if (w) w(); else this.free++; }
}

async function uploadFile(job, f, idx) {
  const base = `/api/send/t/${job.id}/f/${idx}`;
  const { signal } = job.ctl;
  const sent = new Map(); // part -> bytes
  const report = (k, n) => { sent.set(k, n); job.fileSent[idx] = [...sent.values()].reduce((a, b) => a + b, 0); job.tick(); };

  if (f.size <= PART) {
    await job.slots.take();
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const crc = crc32Update(0, buf);
      await withRetry(() => xhrPut(`${base}?crc=${crc}`, buf, (n) => report(0, n), signal), signal);
      report(0, f.size);
    } finally { job.slots.give(); }
    return;
  }

  const { uploadId } = await api(`/t/${job.id}/f/${idx}/mpu`, { method: 'POST', signal });
  if (!uploadId) throw new Error('No upload id');
  const count = Math.ceil(f.size / PART);
  let crc = 0;
  const pending = [];
  const parts = [];
  for (let n = 1; n <= count; n++) {
    await job.slots.take(); // read the next part only when a request slot is free
    if (signal.aborted) { job.slots.give(); break; }
    let buf;
    try {
      buf = new Uint8Array(await f.slice((n - 1) * PART, Math.min(n * PART, f.size)).arrayBuffer());
      crc = crc32Update(crc, buf); // parts are read in order, so the CRC is correct
    } catch (err) { job.slots.give(); throw err; }
    pending.push(
      withRetry(() => xhrPut(`${base}/part/${n}`, buf, (b) => report(n, b), signal), signal)
        .then((p) => { parts.push({ partNumber: p.partNumber, etag: p.etag }); report(n, buf.length); })
        .catch((err) => { job.error ||= err; job.ctl.abort(); throw err; })
        .finally(() => job.slots.give()),
    );
  }
  await Promise.all(pending);
  parts.sort((a, b) => a.partNumber - b.partNumber);
  await withRetry(() => api(`/t/${job.id}/f/${idx}/complete`, { method: 'POST', body: JSON.stringify({ parts, crc32: crc }), signal }), signal);
}

function setProgress(frac, text, sub) {
  const pct = Math.floor(frac * 100);
  $('pct').textContent = `${pct}%`;
  $('ringBar').style.strokeDashoffset = String(326.7 * (1 - frac));
  if (text) $('statusText').textContent = text;
  if (sub !== undefined) $('statusSub').textContent = sub;
}

async function start() {
  if (!queue.length || active) return;
  const total = queue.reduce((a, q) => a + q.file.size, 0);
  const files = queue.map((q) => ({ path: q.path, size: q.file.size, type: q.file.type || 'application/octet-stream' }));
  $('composer').hidden = true;
  $('progress').hidden = false;
  setProgress(0, 'Preparing...', `${files.length} file${files.length === 1 ? '' : 's'}, ${fmtSize(total)}`);

  const job = { ctl: new AbortController(), slots: new Slots(MAX_REQ), fileSent: new Array(files.length).fill(0), id: null };
  active = job;
  const t0 = Date.now();
  job.tick = () => {
    const done = job.fileSent.reduce((a, b) => a + b, 0);
    const secs = (Date.now() - t0) / 1000;
    const rate = done / Math.max(secs, 0.5);
    const left = rate > 0 ? (total - done) / rate : 0;
    setProgress(total ? done / total : 1, 'Uploading...', `${fmtSize(done)} of ${fmtSize(total)}${rate > 0 && done < total ? `, about ${fmtLeft(left * 1000)} left` : ''}`);
  };

  try {
    const created = await api('/transfers', { method: 'POST', body: JSON.stringify({ title: $('title').value.trim(), message: $('message').value.trim(), files }) });
    job.id = created.id;
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !job.ctl.signal.aborted) {
        const i = next++;
        await uploadFile(job, queue[i].file, i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    if (job.ctl.signal.aborted) throw new Error('Cancelled');
    setProgress(1, 'Finishing...');
    const fin = await api(`/t/${job.id}/finalize`, { method: 'POST' });
    $('progress').hidden = true;
    $('done').hidden = false;
    $('shareUrl').value = fin.url;
    $('doneSub').textContent = `Deletes itself on ${new Date(fin.expiresAt).toLocaleString()}.`;
  } catch (err) {
    if (!job.ctl.signal.aborted) job.error ||= err;
    job.ctl.abort();
    if (job.id) api(`/t/${job.id}`, { method: 'DELETE' }).catch(() => {});
    $('progress').hidden = true;
    $('composer').hidden = false;
    const real = job.error || err;
    if (!(job.cancelled && !job.error)) alert(`Upload failed: ${real.message}`);
  } finally {
    active = null;
  }
}

/* ---------- transfers list ---------- */

async function loadList() {
  const body = $('listBody');
  body.textContent = '';
  const { transfers, origin } = await api('/transfers');
  $('listEmpty').hidden = transfers.length > 0;
  for (const t of transfers) {
    const tr = document.createElement('tr');
    const cell = (txt, cls) => { const td = document.createElement('td'); td.textContent = txt; if (cls) td.className = cls; tr.append(td); return td; };
    const name = cell(t.title || 'Untitled');
    const by = document.createElement('div'); by.className = 'sub'; by.textContent = `${t.file_count} file${t.file_count === 1 ? '' : 's'}, by ${t.created_by}`;
    name.append(by);
    cell(fmtSize(t.total_size));
    cell(String(t.download_count));
    cell(fmtLeft(t.expires_at - Date.now()));
    const act = cell('', 'actions');
    const copy = document.createElement('button'); copy.className = 'link'; copy.textContent = 'Copy link';
    copy.onclick = async () => { await navigator.clipboard.writeText(`${origin}/d/${t.id}`); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy link'), 1500); };
    const del = document.createElement('button'); del.className = 'link danger'; del.textContent = 'Delete now';
    del.onclick = async () => { if (!confirm(`Delete "${t.title || 'Untitled'}" now? The link stops working.`)) return; await api(`/t/${t.id}`, { method: 'DELETE' }); loadList(); };
    act.append(copy, del);
    body.append(tr);
  }
}

/* ---------- wiring ---------- */

function resetComposer() {
  queue = []; renderQueue();
  $('title').value = ''; $('message').value = '';
  $('done').hidden = true; $('composer').hidden = false;
}

window.addEventListener('DOMContentLoaded', async () => {
  $('pickFiles').onchange = (e) => { addFiles([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ''; };
  $('pickFolder').onchange = (e) => { addFiles([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ''; };
  $('clearAll').onclick = () => { queue = []; renderQueue(); };
  $('go').onclick = start;
  $('cancel').onclick = () => { if (active) { active.cancelled = true; active.ctl.abort(); } };
  $('another').onclick = resetComposer;
  $('copy').onclick = async () => { await navigator.clipboard.writeText($('shareUrl').value); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy'), 1500); };
  for (const b of document.querySelectorAll('.tab')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('.tab')) { o.classList.toggle('active', o === b); o.setAttribute('aria-selected', String(o === b)); }
      $('tab-new').hidden = b.dataset.tab !== 'new';
      $('tab-list').hidden = b.dataset.tab !== 'list';
      if (b.dataset.tab === 'list') loadList().catch((e) => alert(e.message));
    };
  }
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { depth++; $('dropzone').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropzone').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { depth = 0; onDrop(e); });
  window.addEventListener('beforeunload', (e) => { if (active) e.preventDefault(); });
  try { const me = await api('/me'); $('who').textContent = me.email; } catch {}
});
