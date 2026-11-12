// Live checks against the deployed site. Run: npm run check:live
// Each check guards a problem found on the real deploy, not in local tests.
const U = process.env.LIVE_ORIGIN;
if (!U) { console.error('set LIVE_ORIGIN, for example LIVE_ORIGIN=https://transfer.example.com'); process.exit(2); }
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const errors = [];
const rule = (ok, msg) => { if (!ok) errors.push(msg); };
const get = (p, ua = BROWSER) => fetch(U + p, { headers: { 'user-agent': ua }, redirect: 'manual' });

// Cloudflare "managed robots.txt" (zone setting) prepends "User-agent: * / Allow: /".
// Crawlers merge the "*" groups (RFC 9309): the longest matching rule wins, a tie goes to Allow.
function allowed(txt, path) {
  const rules = [];
  let star = false, inRules = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (inRules) { star = false; inRules = false; }
      if (val === '*') star = true;
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (star && val) rules.push({ allow: key === 'allow', val });
    }
  }
  let best = null;
  for (const r of rules) {
    const body = r.val.endsWith('$') ? r.val.slice(0, -1) : r.val;
    const src = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (!new RegExp('^' + src + (r.val.endsWith('$') ? '$' : '')).test(path)) continue;
    if (!best || r.val.length > best.val.length || (r.val.length === best.val.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
// Self-test: the evaluator must reproduce the managed robots.txt bug.
rule(allowed('User-agent: *\nAllow: /\n\nUser-agent: *\nDisallow: /\n', '/d/x'), 'robots evaluator self-test failed');
const robots = await (await get('/robots.txt')).text();
for (const p of ['/', '/d/AAAAAAAAAAAAAAAAAAAAAA', '/api/d/x/open', '/send', '/assets/send.js', '/robots.txt'])
  rule(!allowed(robots, p), `robots.txt lets crawlers fetch ${p}`);

// /send is answered by Cloudflare Access (302 to the login page) before the Worker runs.
for (const p of ['/', '/robots.txt', '/d/AAAAAAAAAAAAAAAAAAAAAA']) {
  const r = await get(p);
  rule(/noindex/.test(r.headers.get('x-robots-tag') || ''), `${p}: X-Robots-Tag noindex missing`);
}
rule((await get('/')).status === 404, '/ must be 404');
for (const p of ['/send', '/api/send/me']) {
  const r = await get(p);
  rule(r.status === 302 && /\.cloudflareaccess\.com\//.test(r.headers.get('location') || ''), `${p} must redirect to Cloudflare Access login`);
}
rule((await get('/d/AAAAAAAAAAAAAAAAAAAAAA', 'Googlebot/2.1')).status === 404, 'bot user agent must get 404');

if (errors.length) { console.error('live: ' + errors.join('\nlive: ')); process.exit(1); }
console.log('live: ok');
