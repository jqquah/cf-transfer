import { senderEmail } from './auth.js';
import { planZip, zipStream } from './zip.js';
import { flushNotices } from './notify.js';

const PART_SIZE = 50 * 1024 * 1024; // must match public/assets/send.js
const MAX_FILES = 2000;
const MAX_TOTAL = 100 * 1024 ** 3; // 100 GiB per transfer
// Over-long input is refused with 400, never cut short in silence.
const MAX_TITLE = 200;
const MAX_MESSAGE = 4000;
const MAX_PATH = 900;
// Only a plain type/subtype is stored; anything else is served as octet-stream.
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
// CRC-32 from the client must be a uint32 in decimal.
const CRC = /^\d{1,10}$/;
const ABANDON_MS = 24 * 3600 * 1000; // unfinished uploads go after 24 h
const TOKEN_MS = 6 * 3600 * 1000; // a recipient page session lasts 6 h

const BOT_UA = /bot|crawl|spider|slurp|archiver|facebookexternalhit|meta-externalagent|whatsapp|telegram|slack|discord|skype|linkedin|twitter|embedly|preview|pinterest|quora|vkshare|outbrain|bingpreview|headless|phantom|puppeteer|playwright|curl|wget|python|httpclient|okhttp|go-http|java\/|libwww|axios|node-fetch|scrapy|ahrefs|semrush|mj12|yandex|baidu|duckduck|petal|bytespider|gptbot|chatgpt|claude|anthropic|perplexity|ccbot|google-extended|applebot/i;

// Cloudflare "managed robots.txt" on the zone prepends "User-agent: * / Allow: /".
// Crawlers merge both "*" groups; the longest matching rule wins and a tie goes
// to Allow. "Disallow: /*" is longer than "Allow: /", so it wins on every path.
// No per-route lines: they only map the app for an attacker.
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\nDisallow: /*\n';
const ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate';
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function secure(res, { cache = false } = {}) {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set('X-Robots-Tag', ROBOTS);
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', CSP);
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!cache) h.set('Cache-Control', 'no-store, private');
  return r;
}

const json = (data, status = 200) => Response.json(data, { status });
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
const gone = () => json({ error: 'This link has expired or does not exist.' }, 404);

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

async function hmac(env, msg) {
  if (!env.SIGNING_KEY || env.SIGNING_KEY.length < 32) throw new Error('SIGNING_KEY secret is missing');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))));
}
async function makeToken(env, id, exp) {
  return `${exp}.${await hmac(env, `${id}.${exp}`)}`;
}
async function checkToken(env, id, token, now) {
  const [expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp <= now) return false;
  const want = await hmac(env, `${id}.${exp}`);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function cleanPath(p) {
  const parts = String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/') || 'file';
}

function dedupe(paths) {
  const seen = new Set();
  return paths.map((p) => {
    let q = p;
    for (let n = 2; seen.has(q.toLowerCase()); n++) {
      const dot = p.lastIndexOf('.');
      const slash = p.lastIndexOf('/');
      q = dot > slash + 1 ? `${p.slice(0, dot)} (${n})${p.slice(dot)}` : `${p} (${n})`;
    }
    seen.add(q.toLowerCase());
    return q;
  });
}

const ttlMs = (env) => Number(env.TTL_SECONDS || 432000) * 1000;
const isExpired = (t, now) => t.status === 'ready' && now >= t.expires_at;
const origin = (env, req) => env.PUBLIC_ORIGIN || (req ? new URL(req.url).origin : '');

// Delete R2 bytes first, the D1 rows last. Safe to repeat (spec: NoOrphanObjects).
export async function purgeTransfer(env, id) {
  const { results: open } = await env.DB.prepare('SELECT idx, mpu_id FROM files WHERE transfer_id = ? AND mpu_id IS NOT NULL AND uploaded = 0').bind(id).all();
  for (const f of open) {
    try { await env.BUCKET.resumeMultipartUpload(`t/${id}/${f.idx}`, f.mpu_id).abort(); } catch {}
  }
  for (;;) {
    const list = await env.BUCKET.list({ prefix: `t/${id}/`, limit: 1000 });
    if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
    if (!list.truncated && list.objects.length === 0) break;
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE transfer_id = ?').bind(id),
    env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(id),
  ]);
}

export async function sweep(env, now = Date.now()) {
  await flushNotices(env, origin(env), now);
  const { results } = await env.DB.prepare(
    "SELECT id FROM transfers WHERE (status = 'ready' AND expires_at <= ?) OR (status = 'uploading' AND created_at <= ?) LIMIT 100",
  ).bind(now, now - ABANDON_MS).all();
  for (const r of results) {
    try { await purgeTransfer(env, r.id); } catch (err) { console.error('purge failed', r.id, err?.message || err); }
  }
  // Notified events of purged transfers are no longer needed.
  await env.DB.prepare('DELETE FROM downloads WHERE notified = 1 AND transfer_id NOT IN (SELECT id FROM transfers)').run();
  return results.length;
}

/* ---------------- sender API (behind Cloudflare Access) ---------------- */

async function senderApi(req, env, url, email, ctx) {
  const now = Date.now();
  const p = url.pathname.replace(/^\/api\/send/, '');
  const m = p.match(/^\/t\/([\w-]{22})(?:\/f\/(\d+)(?:\/(mpu|complete|part\/(\d+)))?|\/(finalize))?$/);

  if (p === '/me' && req.method === 'GET') return json({ email, ttlSeconds: ttlMs(env) / 1000, partSize: PART_SIZE });

  if (p === '/transfers' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT id, title, created_by, created_at, ready_at, expires_at, total_size, file_count, download_count FROM transfers WHERE status = 'ready' AND expires_at > ? ORDER BY ready_at DESC LIMIT 200",
    ).bind(now).all();
    return json({ transfers: results, origin: origin(env, req) });
  }

  if (p === '/transfers' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length || files.length > MAX_FILES) return json({ error: `Send 1 to ${MAX_FILES} files.` }, 400);
    let total = 0;
    for (const f of files) {
      if (!Number.isSafeInteger(f.size) || f.size < 0) return json({ error: 'Bad file size.' }, 400);
      total += f.size;
    }
    if (total > MAX_TOTAL) return json({ error: 'A transfer can be 100 GB at most.' }, 400);
    const title = String(body.title || '');
    const message = String(body.message || '');
    if (title.length > MAX_TITLE) return json({ error: `Title can be ${MAX_TITLE} characters at most.` }, 400);
    if (message.length > MAX_MESSAGE) return json({ error: `Message can be ${MAX_MESSAGE} characters at most.` }, 400);
    const cleaned = files.map((f) => cleanPath(f.path));
    if (cleaned.some((c) => c.length > MAX_PATH)) return json({ error: `A file path can be ${MAX_PATH} characters at most.` }, 400);
    const paths = dedupe(cleaned);
    const id = newId();
    const stmts = [
      env.DB.prepare("INSERT INTO transfers (id, title, message, created_by, created_at, status, total_size, file_count) VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?)")
        .bind(id, title, message, email, now, total, files.length),
    ];
    const ROWS = 16; // D1 allows 100 bound parameters per statement; 5 per row
    for (let i = 0; i < files.length; i += ROWS) {
      const chunk = files.slice(i, i + ROWS);
      const args = chunk.flatMap((f, j) => [id, i + j, paths[i + j], f.size, MIME.test(String(f.type || '')) ? String(f.type) : 'application/octet-stream']);
      stmts.push(env.DB.prepare(`INSERT INTO files (transfer_id, idx, path, size, type) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`).bind(...args));
    }
    await env.DB.batch(stmts);
    return json({ id, files: paths.map((path, idx) => ({ idx, path })) });
  }

  if (!m) return notFound();
  const [, id, idxStr, action, partStr, finalize] = m;
  const t = await env.DB.prepare('SELECT * FROM transfers WHERE id = ?').bind(id).first();
  if (!t) return notFound();

  if (!idxStr && !finalize && req.method === 'DELETE') {
    await purgeTransfer(env, id);
    return json({ ok: true });
  }
  if (t.status !== 'uploading' || t.created_by !== email) return json({ error: 'This transfer is closed.' }, 409);

  if (finalize && req.method === 'POST') {
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE transfer_id = ? AND uploaded = 0').bind(id).first();
    if (left.n > 0) return json({ error: `${left.n} file(s) are not uploaded yet.` }, 409);
    const expires = now + ttlMs(env);
    await env.DB.prepare("UPDATE transfers SET status = 'ready', ready_at = ?, expires_at = ? WHERE id = ? AND status = 'uploading'").bind(now, expires, id).run();
    return json({ url: `${origin(env, req)}/d/${id}`, expiresAt: expires });
  }

  const idx = Number(idxStr);
  const f = await env.DB.prepare('SELECT * FROM files WHERE transfer_id = ? AND idx = ?').bind(id, idx).first();
  if (!f) return notFound();
  if (f.uploaded) return json({ error: 'Already uploaded.' }, 409);
  const key = `t/${id}/${idx}`;
  const crc = (v) => (v === null || v === undefined || v === '' ? null : CRC.test(String(v)) && Number(v) <= 0xffffffff ? Number(v) : undefined);

  if (!action && req.method === 'PUT') {
    if (f.size > PART_SIZE) return json({ error: 'Use multipart for this file.' }, 400);
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len !== f.size) return json({ error: 'Size does not match.' }, 400);
    if (crc(url.searchParams.get('crc')) === undefined) return json({ error: 'Bad checksum.' }, 400);
    const obj = await env.BUCKET.put(key, f.size === 0 ? '' : req.body, { httpMetadata: { contentType: f.type } });
    if (obj.size !== f.size) { await env.BUCKET.delete(key); return json({ error: 'Size does not match.' }, 400); }
    await env.DB.prepare('UPDATE files SET uploaded = 1, crc32 = ? WHERE transfer_id = ? AND idx = ?').bind(crc(url.searchParams.get('crc')), id, idx).run();
    return json({ ok: true });
  }
  if (action === 'mpu' && req.method === 'POST') {
    const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: f.type } });
    await env.DB.prepare('UPDATE files SET mpu_id = ? WHERE transfer_id = ? AND idx = ?').bind(mpu.uploadId, id, idx).run();
    return json({ uploadId: mpu.uploadId });
  }
  if (partStr && req.method === 'PUT') {
    if (!f.mpu_id) return json({ error: 'No multipart upload.' }, 409);
    const n = Number(partStr);
    const parts = Math.ceil(f.size / PART_SIZE);
    if (n < 1 || n > parts) return json({ error: 'Bad part number.' }, 400);
    const want = n < parts ? PART_SIZE : f.size - PART_SIZE * (parts - 1);
    if (Number(req.headers.get('content-length')) !== want) return json({ error: 'Bad part size.' }, 400);
    const part = await env.BUCKET.resumeMultipartUpload(key, f.mpu_id).uploadPart(n, req.body);
    return json(part);
  }
  if (action === 'complete' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    if (!f.mpu_id || !Array.isArray(body?.parts)) return json({ error: 'Bad request.' }, 400);
    if (crc(body.crc32) === undefined) return json({ error: 'Bad checksum.' }, 400);
    const obj = await env.BUCKET.resumeMultipartUpload(key, f.mpu_id).complete(body.parts.map((x) => ({ partNumber: Number(x.partNumber), etag: String(x.etag) })));
    if (obj.size !== f.size) { await env.BUCKET.delete(key); return json({ error: 'Size does not match.' }, 400); }
    await env.DB.prepare('UPDATE files SET uploaded = 1, mpu_id = NULL, crc32 = ? WHERE transfer_id = ? AND idx = ?').bind(crc(body.crc32), id, idx).run();
    return json({ ok: true });
  }
  return notFound();
}

/* ---------------- recipient API (public, unlisted) ---------------- */

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  return out.success === true;
}

async function logDownload(env, req, t, what, ctx) {
  const cf = req.cf || {};
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO downloads (transfer_id, title, what, at, ip, country, city, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(t.id, t.title || 'Untitled transfer', what, now, req.headers.get('cf-connecting-ip'), cf.country || null, cf.city || null, (req.headers.get('user-agent') || '').slice(0, 300)),
    env.DB.prepare('UPDATE transfers SET download_count = download_count + 1 WHERE id = ?').bind(t.id),
  ]);
  ctx.waitUntil(flushNotices(env, origin(env, req), now, t.id).catch((e) => console.error('notice failed', e?.message || e)));
}

const disposition = (name) => {
  const base = name.split('/').pop() || 'file';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
};

async function recipientApi(req, env, url, ctx) {
  const now = Date.now();
  const m = url.pathname.match(/^\/api\/d\/([\w-]{22})\/(open|zip|f\/(\d+))$/);
  if (!m) return notFound();
  const [, id, action, idxStr] = m;
  const t = await env.DB.prepare('SELECT * FROM transfers WHERE id = ?').bind(id).first();
  if (!t || t.status !== 'ready') return gone();
  if (isExpired(t, now)) {
    ctx.waitUntil(purgeTransfer(env, id).catch(() => {}));
    return gone();
  }

  if (action === 'open') {
    if (req.method !== 'POST') return notFound();
    // Per-IP limit on minting download tokens. Free: no extra charge.
    if (env.OPEN_LIMIT && !(await env.OPEN_LIMIT.limit({ key: req.headers.get('cf-connecting-ip') || 'local' })).success) return json({ error: 'Too many requests. Wait a minute.' }, 429);
    const body = await req.json().catch(() => ({}));
    if (!(await verifyTurnstile(env, body.turnstile, req.headers.get('cf-connecting-ip')))) return json({ error: 'Check failed. Reload the page.' }, 403);
    const { results } = await env.DB.prepare('SELECT idx, path, size, crc32 FROM files WHERE transfer_id = ? ORDER BY idx').bind(id).all();
    const exp = Math.min(now + TOKEN_MS, t.expires_at);
    return json({
      title: t.title, message: t.message, total: t.total_size, expiresAt: t.expires_at, now,
      files: results.map((f) => ({ idx: f.idx, path: f.path, size: f.size })),
      zip: results.length > 0 && results.every((f) => f.crc32 !== null),
      token: await makeToken(env, id, exp),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
  if (!(await checkToken(env, id, url.searchParams.get('t'), now))) return json({ error: 'This download link timed out. Reload the page.' }, 403);

  if (idxStr !== undefined) {
    const f = await env.DB.prepare('SELECT path, size, type FROM files WHERE transfer_id = ? AND idx = ?').bind(id, Number(idxStr)).first();
    if (!f) return notFound();
    const range = req.headers.get('range');
    const obj = await env.BUCKET.get(`t/${id}/${idxStr}`, range ? { range: req.headers } : {});
    if (!obj) return gone();
    const h = new Headers({ 'Content-Type': f.type || 'application/octet-stream', 'Content-Disposition': disposition(f.path), 'Accept-Ranges': 'bytes', ETag: obj.httpEtag });
    let status = 200;
    if (range && obj.range) {
      const off = obj.range.offset ?? 0;
      const len = obj.range.length ?? f.size - off;
      h.set('Content-Range', `bytes ${off}-${off + len - 1}/${f.size}`);
      h.set('Content-Length', String(len));
      status = 206;
    } else {
      h.set('Content-Length', String(f.size));
    }
    // A resumed or chunked download sends many Range requests; log only the first.
    const first = !range || (obj.range?.offset ?? 0) === 0;
    if (req.method === 'GET' && first) await logDownload(env, req, t, `File: ${f.path}`, ctx);
    return new Response(req.method === 'HEAD' ? null : obj.body, { status, headers: h });
  }

  // zip of everything
  const { results } = await env.DB.prepare('SELECT idx, path, size, crc32 FROM files WHERE transfer_id = ? ORDER BY idx').bind(id).all();
  if (results.some((f) => f.crc32 === null)) return json({ error: 'Download the files one by one.' }, 409);
  const plan = planZip(results.map((f) => ({ name: f.path, size: f.size, crc32: f.crc32, mtime: t.ready_at, idx: f.idx })));
  const name = `${cleanPath(t.title || 'transfer').replace(/\//g, '-')}.zip`;
  const h = new Headers({ 'Content-Type': 'application/zip', 'Content-Disposition': disposition(name), 'Content-Length': String(plan.total) });
  if (req.method === 'HEAD') return new Response(null, { headers: h });
  await logDownload(env, req, t, `All files (zip, ${results.length} file${results.length === 1 ? '' : 's'})`, ctx);
  const body = zipStream(plan, async (it) => {
    const obj = await env.BUCKET.get(`t/${id}/${it.idx}`);
    if (!obj) throw new Error('missing object');
    return obj.body;
  }, () => new FixedLengthStream(plan.total));
  return new Response(body, { headers: h });
}

/* ---------------- router ---------------- */

async function page(env, req, name, inject = {}) {
  const res = await env.ASSETS.fetch(new Request(new URL(`/${name}`, req.url)));
  let html = await res.text();
  for (const [k, v] of Object.entries(inject)) html = html.replaceAll(`{{${k}}}`, String(v).replace(/[<>"&']/g, ''));
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const ua = req.headers.get('user-agent') || '';

  if (path === '/robots.txt') return new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain' } });
  if (path.startsWith('/assets/') && req.method === 'GET') return secure(await env.ASSETS.fetch(req), { cache: true });

  if (path === '/send' || path === '/send/' || path.startsWith('/api/send/')) {
    const email = await senderEmail(req, env);
    if (!email) return new Response('Forbidden', { status: 403 });
    if (path.startsWith('/api/')) {
      // Custom header forces a CORS preflight, which blocks cross-site requests.
      if (req.headers.get('x-requested-with') !== 'transfer') return new Response('Forbidden', { status: 403 });
      return senderApi(req, env, url, email, ctx);
    }
    return page(env, req, 'send');
  }

  if (path.startsWith('/d/') || path.startsWith('/api/d/')) {
    // Gate on the user agent only. Cloudflare tags corporate web proxies (Netskope,
    // Zscaler) as verified bots, category "Security", but real people sit behind them.
    // The page holds no data and the file list needs Turnstile, so this is safe.
    if (!ua || BOT_UA.test(ua)) return notFound();
    if (path.startsWith('/api/')) return recipientApi(req, env, url, ctx);
    if (!/^\/d\/[\w-]{22}$/.test(path) || req.method !== 'GET') return notFound();
    // The shell holds no transfer data; it loads only after JavaScript runs.
    return page(env, req, 'recipient', { TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || '' });
  }

  return notFound();
}

export default {
  async fetch(req, env, ctx) {
    try {
      return secure(await handle(req, env, ctx));
    } catch (err) {
      console.error('request failed', err?.stack || err);
      return secure(json({ error: 'Something went wrong. Try again.' }, 500));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env, Date.now()));
  },
};
