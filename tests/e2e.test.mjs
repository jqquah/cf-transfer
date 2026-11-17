// End-to-end test against a running `wrangler dev` (local R2, D1, email).
// Start: npx wrangler dev --port 8799 --test-scheduled  (uses .dev.vars: TTL 10 s, cooldown 4 s)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8799';
const EXP = `${BASE}/cdn-cgi/local/explorer/api`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const SEND_H = { 'X-Requested-With': 'transfer', 'User-Agent': UA };
const PART = 50 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let up = false;
before(async () => { up = await fetch(`${BASE}/robots.txt`).then((r) => r.ok, () => false); });
const t2 = (name, fn) => test(name, async (t) => { if (!up) return t.skip('wrangler dev is not running'); await fn(t); });

let dbId;
const sql = async (q, params = []) => {
  // Look up the local D1 id: a hardcoded id breaks when wrangler.jsonc gets the real one.
  dbId ??= (await fetch(`${EXP}/d1/database`).then((r) => r.json())).result.find((d) => d.name === 'DB').uuid;
  const r = await fetch(`${EXP}/d1/database/${dbId}/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: q, params }) }).then((r) => r.json());
  return r.result[0].results;
};
const rows = (res) => res.rows.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])));
const r2Keys = async (prefix) => (await fetch(`${EXP}/r2/buckets/transfer/objects?prefix=${encodeURIComponent(prefix)}`).then((r) => r.json())).result.map((o) => o.key);
const cron = () => fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`);

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/send${path}`, { ...opts, headers: { ...SEND_H, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

function pattern(n, seed) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (Math.imul(i + seed, 2654435761) >>> 13) & 255;
  return b;
}

async function sendTransfer(title, files) {
  const created = await api('/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message: 'Test message', files: files.map((f) => ({ path: f.path, size: f.data.length, type: 'application/octet-stream' })) }) });
  for (const [idx, f] of files.entries()) {
    const base = `/t/${created.id}/f/${idx}`;
    if (f.data.length <= PART) {
      await api(`${base}?crc=${crc32(f.data)}`, { method: 'PUT', body: f.data });
    } else {
      const { uploadId } = await api(`${base}/mpu`, { method: 'POST' });
      assert.ok(uploadId);
      const parts = [];
      for (let n = 1; (n - 1) * PART < f.data.length; n++) parts.push(await api(`${base}/part/${n}`, { method: 'PUT', body: f.data.subarray((n - 1) * PART, n * PART) }));
      await api(`${base}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts, crc32: crc32(f.data) }) });
    }
  }
  const fin = await api(`/t/${created.id}/finalize`, { method: 'POST' });
  return { id: created.id, paths: created.files.map((f) => f.path), ...fin };
}

// ip sets the client IP the per-IP open limit sees (local dev only).
const openT = (id, ua = UA, ip = '192.0.2.1') => fetch(`${BASE}/api/d/${id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'CF-Connecting-IP': ip }, body: '{}' });

t2('quiet surface: robots, noindex headers, 404 root, bots blocked, shell has no data', async () => {
  const robots = await fetch(`${BASE}/robots.txt`).then((r) => r.text());
  assert.match(robots, /^User-agent: \*\nDisallow: \/\n/);
  assert.match(robots, /^Disallow: \/\*$/m); // beats a managed "Allow: /" prefix
  assert.doesNotMatch(robots, /\/(d|api|send|assets)\b/); // no route map
  const root = await fetch(`${BASE}/`, { headers: { 'User-Agent': UA } });
  assert.equal(root.status, 404);
  assert.match(root.headers.get('x-robots-tag'), /noindex/);
  const t = await sendTransfer('Secret Deck Q4', [{ path: 'a.txt', data: Buffer.from('a') }]);
  for (const ua of ['Googlebot/2.1', 'facebookexternalhit/1.1', 'WhatsApp/2.23', 'Slackbot-LinkExpanding 1.0', 'curl/8.4', 'python-requests/2.31', 'Mozilla/5.0 HeadlessChrome/120', 'GPTBot/1.0', '']) {
    const r = await fetch(`${BASE}/d/${t.id}`, { headers: { 'User-Agent': ua } });
    assert.equal(r.status, 404, `page for UA ${ua}`);
    assert.equal((await openT(t.id, ua)).status, 404, `api for UA ${ua}`);
  }
  const shell = await fetch(`${BASE}/d/${t.id}`, { headers: { 'User-Agent': UA } });
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.ok(!html.includes('Secret Deck') && !html.includes('a.txt'), 'shell must not leak transfer data');
  assert.match(html, /noindex/);
  assert.ok(!/og:|twitter:/.test(html), 'no link-preview tags');
  // unknown id gives the same shell (no existence oracle)
  const fake = await fetch(`${BASE}/d/AAAAAAAAAAAAAAAAAAAAAA`, { headers: { 'User-Agent': UA } });
  assert.equal(fake.status, 200);
  assert.equal((await openT('AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

t2('sender API needs the CSRF header', async () => {
  const r = await fetch(`${BASE}/api/send/me`, { headers: { 'User-Agent': UA } });
  assert.equal(r.status, 403);
  assert.equal((await api('/me')).email, 'alice@example.com');
});

t2('upload files + folder + multipart, download each, ranges, zip; notices batch', async () => {
  const files = [
    { path: 'Deck.pdf', data: pattern(1234, 1) },
    { path: 'Photos/Day 1/日本語.jpg', data: pattern(300_000, 2) },
    { path: 'Photos/Day 1/empty.txt', data: Buffer.alloc(0) },
    { path: '../../etc/passwd', data: Buffer.from('x') },
    { path: 'Deck.pdf', data: Buffer.from('dupe') },
    { path: 'Big/video.mov', data: pattern(PART + 3_000_001, 3) },
  ];
  const t = await sendTransfer('E2E', files);
  assert.deepEqual(t.paths, ['Deck.pdf', 'Photos/Day 1/日本語.jpg', 'Photos/Day 1/empty.txt', 'etc/passwd', 'Deck (2).pdf', 'Big/video.mov']);
  assert.equal((await r2Keys(`t/${t.id}/`)).length, files.length);

  const info = await openT(t.id).then((r) => r.json());
  assert.equal(info.files.length, files.length);
  assert.equal(info.zip, true);
  assert.ok(Math.abs(info.expiresAt - (Date.now() + 10_000)) < 3000);

  // bad token
  assert.equal((await fetch(`${BASE}/api/d/${t.id}/f/0?t=1.abc`, { headers: { 'User-Agent': UA } })).status, 403);

  for (const [i, f] of files.entries()) {
    const r = await fetch(`${BASE}/api/d/${t.id}/f/${i}?t=${encodeURIComponent(info.token)}`, { headers: { 'User-Agent': UA } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(f.data), `bytes of ${f.path}`);
  }
  const rg = await fetch(`${BASE}/api/d/${t.id}/f/1?t=${encodeURIComponent(info.token)}`, { headers: { 'User-Agent': UA, Range: 'bytes=100-199' } });
  assert.equal(rg.status, 206);
  assert.equal(rg.headers.get('content-range'), 'bytes 100-199/300000');
  assert.ok(Buffer.from(await rg.arrayBuffer()).equals(files[1].data.subarray(100, 200)));

  const z = await fetch(`${BASE}/api/d/${t.id}/zip?t=${encodeURIComponent(info.token)}`, { headers: { 'User-Agent': UA } });
  assert.equal(z.status, 200);
  const zbuf = Buffer.from(await z.arrayBuffer());
  assert.equal(String(zbuf.length), z.headers.get('content-length'));
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  writeFileSync(join(dir, 't.zip'), zbuf);
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json,hashlib;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"h":{n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))', join(dir, 't.zip')]).toString());
  assert.equal(out.bad, null);
  const { createHash } = await import('node:crypto');
  for (const [i, f] of files.entries()) assert.equal(out.h[t.paths[i]], createHash('sha256').update(f.data).digest('hex'), t.paths[i]);

  // 6 file downloads (range non-zero not counted) + 1 zip = 7 events
  const ev = rows(await sql('SELECT what, notified FROM downloads WHERE transfer_id = ? ORDER BY id', [t.id]));
  assert.equal(ev.length, 7);
  await sleep(500);
  const afterFirst = rows(await sql('SELECT notified FROM downloads WHERE transfer_id = ? ORDER BY id', [t.id]));
  assert.equal(afterFirst[0].notified, 1, 'first download notifies at once');
  assert.ok(afterFirst.slice(1).every((e) => e.notified === 0), 'later downloads wait for the cooldown');
  await sleep(4200);
  await cron();
  await sleep(300);
  const all = rows(await sql('SELECT notified FROM downloads WHERE transfer_id = ?', [t.id]));
  assert.ok(all.length === 0 || all.every((e) => e.notified === 1), 'cron sends the batch after cooldown');
});

t2('expires exactly at TTL, cron destroys bytes and rows, pending notices survive', async () => {
  const t = await sendTransfer('Expiry', [{ path: 'x.bin', data: pattern(5000, 9) }, { path: 'y.bin', data: pattern(10, 4) }]);
  const info = await openT(t.id).then((r) => r.json());
  // download right away (notice sent), then again (pending due to cooldown)
  for (let k = 0; k < 2; k++) await fetch(`${BASE}/api/d/${t.id}/f/0?t=${encodeURIComponent(info.token)}`, { headers: { 'User-Agent': UA } }).then((r) => r.arrayBuffer());
  await sleep(300);
  let lastOk = 0, firstFail = 0;
  for (let i = 0; !firstFail; i++) {
    const now = Date.now();
    const r = await openT(t.id, UA, `198.51.${i >> 8}.${i & 255}`); // fresh IP: polling must not hit the open limit
    if (r.ok) lastOk = now; else firstFail = now;
    await sleep(50);
  }
  assert.ok(lastOk < t.expiresAt, 'never open at or after expiry');
  assert.ok(firstFail - t.expiresAt < 400, `closes on time (late by ${firstFail - t.expiresAt} ms)`);
  // old token stops too
  assert.equal((await fetch(`${BASE}/api/d/${t.id}/f/1?t=${encodeURIComponent(info.token)}`, { headers: { 'User-Agent': UA } })).status, 404);
  await cron();
  await sleep(500);
  assert.deepEqual(await r2Keys(`t/${t.id}/`), [], 'R2 bytes deleted');
  assert.equal(rows(await sql('SELECT COUNT(*) AS n FROM transfers WHERE id = ?', [t.id]))[0].n, 0);
  assert.equal(rows(await sql('SELECT COUNT(*) AS n FROM files WHERE transfer_id = ?', [t.id]))[0].n, 0);
  // the pending notice is still sent after the transfer row is gone
  await sleep(4200);
  await cron();
  await sleep(300);
  assert.equal(rows(await sql('SELECT COUNT(*) AS n FROM downloads WHERE transfer_id = ? AND notified = 0', [t.id]))[0].n, 0);
});

t2('abandoned upload and Delete now both purge', async () => {
  const created = await api('/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'half', files: [{ path: 'a', size: 3 }, { path: 'b', size: PART + 10 }] }) });
  await api(`/t/${created.id}/f/0?crc=1`, { method: 'PUT', body: Buffer.from('abc') });
  await api(`/t/${created.id}/f/1/mpu`, { method: 'POST' });
  await assert.rejects(api(`/t/${created.id}/finalize`, { method: 'POST' }), /not uploaded/);
  assert.equal((await openT(created.id)).status, 404, 'unfinished transfers are not visible');
  await api(`/t/${created.id}`, { method: 'DELETE' });
  assert.deepEqual(await r2Keys(`t/${created.id}/`), []);
  assert.equal(rows(await sql('SELECT COUNT(*) AS n FROM transfers WHERE id = ?', [created.id]))[0].n, 0);
});

t2('input limits: over-long input gets 400, bad checksum gets 400, odd type is not stored', async () => {
  const post = (body) => fetch(`${BASE}/api/send/transfers`, { method: 'POST', headers: { ...SEND_H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const one = [{ path: 'a.txt', size: 3, type: 'text/plain' }];
  assert.equal((await post({ title: 'x'.repeat(201), files: one })).status, 400);
  assert.equal((await post({ title: 'x'.repeat(200), message: 'm'.repeat(4001), files: one })).status, 400);
  assert.equal((await post({ files: [{ path: 'p'.repeat(901), size: 3 }] })).status, 400);
  const ok = await post({ title: 'x'.repeat(200), message: 'm'.repeat(4000), files: [{ path: 'p'.repeat(900), size: 3, type: 'application/json\r\nX-Evil: 1' }] });
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  const [f] = rows(await sql('SELECT path, type FROM files WHERE transfer_id = ?', [id]));
  assert.equal(f.path.length, 900);
  assert.equal(f.type, 'application/octet-stream');
  const put = (crc) => fetch(`${BASE}/api/send/t/${id}/f/0?crc=${crc}`, { method: 'PUT', headers: SEND_H, body: 'abc' });
  for (const bad of ['abc', '-1', '4294967296', '1e3']) assert.equal((await put(bad)).status, 400, bad);
  assert.equal((await put(crc32(Buffer.from('abc')))).status, 200);
});

// Keep last: it uses up the per-IP open limit.
t2('open is rate limited per IP', async () => {
  const t = await sendTransfer('rate', [{ path: 'r.txt', data: Buffer.from('r') }]);
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await openT(t.id, UA, '203.0.113.9')).status);
  assert.equal((await openT(t.id, UA, '203.0.113.10')).status, 200, 'other IPs are not blocked');
  assert.ok(codes.includes(200) && codes.includes(429), codes.join(','));
});
