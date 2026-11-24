// Project lint. Each rule guards a failure we found or a property the
// TLA+ model (spec/Transfer.tla) depends on. Run: npm run lint
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const errors = [];
const rule = (ok, msg) => { if (!ok) errors.push(msg); };

const wrangler = read('wrangler.jsonc');
const index = read('src/index.js');
const notify = read('src/notify.js');
const send = read('public/assets/send.js');
const schema = read('migrations/0001_init.sql');

// Auth must fail closed in production: dev bypass lives only in .dev.vars.
rule(!/ALLOW_DEV_AUTH|DEV_SENDER_EMAIL/.test(wrangler), 'wrangler.jsonc must not set ALLOW_DEV_AUTH or DEV_SENDER_EMAIL');
// Exactly 5 days in production (tests use a short TTL in .dev.vars).
rule(/"TTL_SECONDS":\s*"432000"/.test(wrangler), 'wrangler.jsonc TTL_SECONDS must be "432000" (5 days)');
rule(/"workers_dev":\s*false/.test(wrangler) && /"preview_urls":\s*false/.test(wrangler), 'workers_dev and preview_urls must be false (no extra public URLs)');
rule(/"crons":\s*\[\s*"\* \* \* \* \*"\s*\]/.test(wrangler), 'cron must run every minute (expiry purge)');

// Free email path: the sender must be on a subdomain with Email Routing.
// Email Routing on the apex replaces Google Workspace MX and breaks company mail.
const from = wrangler.match(/"NOTIFY_FROM":\s*"([^"]+)"/)?.[1] || '';
const apex = (wrangler.match(/"ALLOWED_EMAIL_DOMAIN":\s*"([^"]+)"/)?.[1] || '').replace(/\./g, '\\.');
rule(new RegExp(`@[a-z0-9-]+\\.${apex}$`).test(from), `NOTIFY_FROM (${from}) must be on a subdomain of ALLOWED_EMAIL_DOMAIN, not the apex (keeps your existing MX)`);
rule(wrangler.includes(`"allowed_sender_addresses": ["${from}"]`), 'send_email allowed_sender_addresses must equal NOTIFY_FROM');
const notifyTo = (wrangler.match(/"NOTIFY_TO":\s*"([^"]+)"/)?.[1] || '').split(',').map((s) => `"${s.trim()}"`).join(', ');
rule(wrangler.includes(`"allowed_destination_addresses": [${notifyTo}]`), 'send_email allowed_destination_addresses must equal NOTIFY_TO (verified addresses, free tier)');

// Client and server part sizes must match, or multipart parts are rejected.
const srvPart = index.match(/const PART_SIZE = ([^;]+);/)?.[1];
const cliPart = send.match(/const PART = ([^;]+);/)?.[1];
rule(srvPart && srvPart === cliPart, `PART_SIZE (${srvPart}) in src/index.js must equal PART (${cliPart}) in public/assets/send.js`);

// NoLostNotice (TLA+): notices must not depend on the transfer row.
rule(!/JOIN\s+transfers/i.test(notify) && !/SELECT[^']*title[^']*FROM transfers/i.test(notify), 'src/notify.js must build notices from downloads rows only (no transfers JOIN)');
rule(/INSERT INTO downloads \(transfer_id, title,/.test(index), 'download events must store their own title');
rule(/CREATE TABLE downloads[\s\S]*title TEXT NOT NULL/.test(schema), 'downloads.title column is required');

// NoOrphanObjects (TLA+): delete R2 bytes before the D1 rows.
const purge = index.slice(index.indexOf('export async function purgeTransfer'), index.indexOf('export async function sweep'));
rule(purge.indexOf('BUCKET.delete') > 0 && purge.indexOf('BUCKET.delete') < purge.indexOf('DELETE FROM transfers'), 'purgeTransfer must delete R2 objects before the transfers row');

// Every response gets the noindex and no-referrer headers.
rule(/return secure\(await handle\(/.test(index), 'fetch() must wrap every response in secure()');
rule(/X-Robots-Tag/.test(index) && /Disallow: \//.test(index), 'X-Robots-Tag header and robots.txt Disallow must stay');
// The zone's managed robots.txt prepends "Allow: /"; only a longer rule beats it.
rule(/const ROBOTS_TXT = '[^']*Disallow: \/\*\\n/.test(index) && /new Response\(ROBOTS_TXT/.test(index), 'robots.txt must serve ROBOTS_TXT with "Disallow: /*"');
if (process.argv.includes('--deploy')) rule(!/REPLACE_/.test(wrangler), 'wrangler.jsonc still has REPLACE_ placeholders');
// Expiry is checked on every recipient request, not only by the cron.
rule(/isExpired\(t, now\)/.test(index.slice(index.indexOf('async function recipientApi'))), 'recipientApi must check expiry on each request');

// Security review: refuse bad input with 400, never cut it short or store it raw.
const createApi = index.slice(index.indexOf("if (p === '/transfers' && req.method === 'POST')"), index.indexOf('if (!m) return notFound();'));
rule(!/\.slice\(0, \d+\)/.test(createApi) && !/\.slice\(0, \d+\)/.test(index.slice(index.indexOf('export function cleanPath'), index.indexOf('function dedupe'))), 'title, message, path and type must be refused with 400 when too long, not truncated');
rule(/MIME\.test\(String\(f\.type/.test(createApi), 'file type must pass the MIME check before it is stored');
rule((index.match(/=== undefined\) return json\(\{ error: 'Bad checksum\.' \}, 400\)/g) || []).length === 2, 'both upload paths (PUT and multipart complete) must refuse a bad CRC-32');
rule(!/const ROBOTS_TXT = '[^']*Disallow: \/[a-z]/.test(index), 'robots.txt must not list routes');

rule(/"ratelimits":\s*\[\{ "name": "OPEN_LIMIT"/.test(wrangler) && /env\.OPEN_LIMIT\.limit\(/.test(index.slice(index.indexOf("if (action === 'open')"))), 'recipient open must keep the OPEN_LIMIT rate limit');

// The e2e test must look up the local D1 id; a hardcoded id broke when the real id was set.
const e2e = read('tests/e2e.test.mjs');
rule(!/d1\/database\/(REPLACE_|[0-9a-f]{8}-)/.test(e2e), 'tests/e2e.test.mjs must not hardcode a D1 database id');

// A partner behind a Netskope proxy got 404: Cloudflare tags such proxies as verified bots.
rule(!/verifiedBotCategory/.test(index), 'recipient routes must not block on cf.verifiedBotCategory (corporate proxies are tagged as bots)');

if (errors.length) { console.error(errors.map((e) => `lint: ${e}`).join('\n')); process.exit(1); }
console.log('lint: ok');
