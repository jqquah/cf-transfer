// Sender auth: verify the Cloudflare Access JWT (RS256) on every /send request.
// Fail closed: no valid token, no access. ALLOW_DEV_AUTH exists only in .dev.vars.

const b64urlToBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let certCache = { at: 0, keys: new Map() };

async function getKey(team, kid) {
  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.has(kid)) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error('certs fetch failed');
    const { keys } = await res.json();
    const map = new Map();
    for (const jwk of keys) {
      map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    certCache = { at: Date.now(), keys: map };
  }
  return certCache.keys.get(kid);
}

// Returns the sender email, or null.
export async function senderEmail(request, env) {
  const domain = String(env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
  if (env.ALLOW_DEV_AUTH === '1' && env.DEV_SENDER_EMAIL) return env.DEV_SENDER_EMAIL;
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud || team.startsWith('REPLACE') || aud.startsWith('REPLACE') || !domain) return null;
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;
  try {
    const [h, p, s] = jwt.split('.');
    const header = b64urlJson(h);
    const claims = b64urlJson(p);
    if (header.alg !== 'RS256') return null;
    const key = await getKey(team, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const now = Date.now() / 1000;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp < now) return null;
    const email = String(claims.email || '').toLowerCase();
    if (!email.endsWith('@' + domain)) return null;
    return email;
  } catch {
    return null;
  }
}
