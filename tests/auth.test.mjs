import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderEmail } from '../src/auth.js';

const team = 'example.cloudflareaccess.com';
const aud = 'aud-123';
const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL_DOMAIN: 'example.com' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
globalThis.fetch = async (u) => {
  assert.equal(String(u), `https://${team}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};

async function jwt(claims, header = { alg: 'RS256', kid: 'k1' }) {
  const h = b64(header), p = b64(claims);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}
const req = (t) => new Request('https://x/send', { headers: t ? { 'cf-access-jwt-assertion': t } : {} });
const good = () => ({ aud: [aud], iss: `https://${team}`, exp: Date.now() / 1000 + 600, email: 'Bob@example.com' });

test('valid Access token gives the sender email', async () => {
  assert.equal(await senderEmail(req(await jwt(good())), env), 'bob@example.com');
});
test('fails closed for every bad token', async () => {
  const cases = [
    null,
    await jwt({ ...good(), aud: ['other'] }),
    await jwt({ ...good(), iss: 'https://evil.cloudflareaccess.com' }),
    await jwt({ ...good(), exp: Date.now() / 1000 - 1 }),
    await jwt({ ...good(), email: 'someone@gmail.com' }),
    await jwt({ ...good(), email: 'x@example.com.evil.com' }),
    await jwt(good(), { alg: 'none', kid: 'k1' }),
    (await jwt(good())).replace(/\.[^.]+$/, '.AAAA'),
    'garbage',
  ];
  for (const t of cases) assert.equal(await senderEmail(req(t), env), null, String(t).slice(0, 40));
});
test('placeholder config and missing config fail closed', async () => {
  const t = await jwt(good());
  assert.equal(await senderEmail(req(t), { ...env, ACCESS_AUD: 'REPLACE_ACCESS_AUD' }), null);
  assert.equal(await senderEmail(req(t), { ...env, ACCESS_TEAM_DOMAIN: '' }), null);
  assert.equal(await senderEmail(req(t), { ...env, ALLOW_DEV_AUTH: '0', DEV_SENDER_EMAIL: 'a@b' }), 'bob@example.com');
});
