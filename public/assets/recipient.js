const $ = (id) => document.getElementById(id);
const id = location.pathname.split('/').pop();

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
  return d ? `${d} day${d === 1 ? '' : 's'} ${h}h` : h ? `${h}h ${m % 60}m` : `${Math.max(1, m)} min`;
};

function fail(msg) {
  $('gate').hidden = true;
  $('content').hidden = true;
  $('err').hidden = false;
  $('err').textContent = msg;
}

async function open(turnstile) {
  const res = await fetch(`/api/d/${id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstile }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return fail(data.error || 'This link has expired or does not exist.');
  render(data);
}

function render(t) {
  const skew = Date.now() - t.now;
  $('gate').hidden = true;
  $('content').hidden = false;
  $('tTitle').textContent = t.title || `${t.files.length} file${t.files.length === 1 ? '' : 's'}`;
  $('tMsg').textContent = t.message || '';
  $('tMsg').hidden = !t.message;
  const meta = () => {
    const left = t.expiresAt - (Date.now() - skew);
    if (left <= 0) return fail('This link has expired.');
    $('tMeta').textContent = `${t.files.length} file${t.files.length === 1 ? '' : 's'}, ${fmtSize(t.total)}. Deletes in ${fmtLeft(left)}.`;
  };
  meta();
  setInterval(meta, 30000);
  const q = `t=${encodeURIComponent(t.token)}`;
  if (t.zip && t.files.length > 1) {
    $('zipBtn').hidden = false;
    $('zipBtn').href = `/api/d/${id}/zip?${q}`;
    $('zipBtn').textContent = `Download all (${fmtSize(t.total)})`;
  }
  const ul = $('tFiles');
  for (const f of t.files) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'fname';
    const parts = f.path.split('/');
    if (parts.length > 1) {
      const dir = document.createElement('span');
      dir.className = 'fdir';
      dir.textContent = parts.slice(0, -1).join('/') + '/';
      name.append(dir);
    }
    name.append(document.createTextNode(parts.at(-1)));
    const size = document.createElement('span');
    size.className = 'fsize';
    size.textContent = fmtSize(f.size);
    const a = document.createElement('a');
    a.className = 'dl';
    a.href = `/api/d/${id}/f/${f.idx}?${q}`;
    a.setAttribute('download', '');
    a.textContent = 'Download';
    li.append(name, size, a);
    ul.append(li);
  }
  // Download links are signed for 6 hours. Reload after that.
  setTimeout(() => location.reload(), 6 * 3600 * 1000 - 60000);
}

window.addEventListener('DOMContentLoaded', () => {
  if (!/^[\w-]{22}$/.test(id)) return fail('This link has expired or does not exist.');
  const key = document.querySelector('meta[name="turnstile-site-key"]').content;
  if (!key) return open(null).catch(() => fail('Could not load. Check your connection and reload.'));
  window.onTurnstileLoad = () => {
    window.turnstile.render('#turnstile', {
      sitekey: key,
      callback: (token) => open(token).catch(() => fail('Could not load. Check your connection and reload.')),
      'error-callback': () => fail('The security check failed. Reload the page.'),
    });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
  s.async = true;
  document.head.append(s);
});
