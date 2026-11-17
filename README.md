# Transfer

A self-hosted file transfer service on Cloudflare: send files and folders by link.
One Worker, one R2 bucket, one D1 database. It runs on the Cloudflare Workers Free plan.

- Drag and drop files or whole folders, or use **Add files** / **Add folders**. Folder paths are kept.
- Large files upload in 50 MiB parts, 4 at a time. Up to 100 GiB and 2,000 files per transfer.
- Recipients get per-file downloads and one **Download all** zip (streamed, ZIP64 for big files).
- Each download sends an email to your team. The first email goes at once. More downloads of
  the same transfer within 10 minutes go in one email.
- Files delete themselves exactly 5 days after the upload completes. The link stops at that
  second. A cron job (every minute) deletes the bytes, then the records.
- Only your team can upload (Cloudflare Access). Recipients need no account.

## Who can see what

| Path | Who |
|---|---|
| `/send`, `/api/send/*` | Your team only (Cloudflare Access, emails ending in `ALLOWED_EMAIL_DOMAIN`). The Worker also checks the Access token itself and fails closed. |
| `/d/<id>` | Anyone with the link. The id is 128-bit random. |
| everything else | 404 |

Bot and crawler defences:
- `robots.txt` disallows all paths. It also beats the `Allow: /` that Cloudflare "managed robots.txt" adds.
- Every response sends `X-Robots-Tag: noindex, nofollow, noarchive, ...` and `Referrer-Policy: no-referrer`.
- No preview (`og:`) tags. Known bot, link-preview and script user agents get 404.
- The recipient page holds no data until JavaScript runs and calls the API.
- File links are signed and last 6 hours. An optional Turnstile check runs before the file list loads.
- Each IP can open links at most 20 times a minute (Workers rate limit binding, no extra charge).
- Too-long titles (200), messages (4,000) and file paths (900) get a 400 error. They are never cut short.
  A file type that is not a plain `type/subtype` is stored as `application/octet-stream`.

## How it works

```
Sender (browser) --Access login--> /send ----> Worker --multipart PUT--> R2  t/<id>/<n>
                                                 |  \--------------------> D1  transfers, files
Recipient -------------------------> /d/<id> --> Worker --stream---------> R2 (file or zip)
                                                 \--> D1 downloads --> email (send_email binding)
Cron (every minute) --> send pending emails, delete expired transfers (R2 first, then D1)
```

The browser computes CRC-32 while it uploads, so the Worker builds the zip without reading
files twice. The lifecycle (upload, expiry, purge, notices) is modelled in TLA+ in `spec/`.

## Cost

On the Workers **Free** plan:
- Workers, D1 and cron: free within the daily limits.
- R2: free up to 10 GB stored, then about USD 0.015 per GB-month. Files delete after 5 days.
- Email: free, because it sends only to **verified destination addresses** in your account.
  Sending to any other address needs Workers Paid. This project does not need that.

R2 needs a payment method on the account before you can turn it on, even for the free tier.

---

## Deploy, step by step

You need:
- A Cloudflare account, with your domain (for example `example.com`) on Cloudflare DNS.
- Node.js 20 or later, and git.
- About 30 minutes.

In the steps below, change these example values to yours:

| Example | Meaning |
|---|---|
| `example.com` | Your domain on Cloudflare |
| `transfer.example.com` | The hostname for this service |
| `notify.example.com` | A subdomain used only to send the download emails |
| `alice@example.com`, `bob@example.com` | The people who get the download emails |

### 1. Get the code

```bash
git clone https://github.com/<you>/<this-repo>.git transfer
cd transfer
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens. Approve the access. Check the result:

```bash
npx wrangler whoami
```

### 3. Turn on R2 and make the bucket

1. In the Cloudflare dashboard, go to **R2 Object Storage** and turn on R2
   (the free tier needs a card on file).
2. Make the bucket:

```bash
npx wrangler r2 bucket create transfer
```

The bucket name must match `bucket_name` in `wrangler.jsonc`.

### 4. Make the D1 database

```bash
npx wrangler d1 create transfer
```

Copy the `database_id` from the output into `wrangler.jsonc`, in place of
`REPLACE_WITH_D1_DATABASE_ID`. If wrangler offers to add a binding for you, say no:
the binding is already there, with the name `DB`.

### 5. Set the download emails (free)

Cloudflare sends free emails only to verified addresses, and only from a domain with
**Email Routing** turned on. If your domain already uses another mail provider (Google
Workspace, Microsoft 365, and so on), do **not** turn on Email Routing for the apex domain:
that needs your MX records and would stop your normal email. Use a subdomain instead.

**5a. Turn on Email Routing for the subdomain only.** The dashboard puts subdomains under the
apex domain settings, so use the API. It adds MX and SPF records on `notify.example.com` only.

```bash
TOKEN=$(npx wrangler auth token 2>/dev/null | tail -1)
ZONE=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=example.com" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).result[0].id))')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/dns" \
  -d '{"name":"notify.example.com"}'
```

Expect `"success": true` and `"status": "ready"`. Check that your apex MX records did not change:

```bash
dig +short MX example.com
dig +short MX notify.example.com
```

If your domain has no other mail provider, you can instead turn on Email Routing for the apex
in the dashboard (**Email Service > Email Routing > Onboard Domain**). Then set `NOTIFY_FROM`
to a subdomain of it anyway, or change the lint rule.

**5b. Add the people who get the emails as destination addresses.**

```bash
npx wrangler email routing addresses create alice@example.com
npx wrangler email routing addresses create bob@example.com
```

Each person gets an email from Cloudflare and must click **Verify email address**.
Until **all** of them verify, no download email goes out. The emails wait and the cron
retries every minute, so none are lost.

**5c. Put the addresses in `wrangler.jsonc`.** These three settings must agree:

```jsonc
"send_email": [{ "name": "EMAIL",
  "allowed_destination_addresses": ["alice@example.com", "bob@example.com"],
  "allowed_sender_addresses": ["transfer@notify.example.com"] }],
"vars": {
  "NOTIFY_TO": "alice@example.com,bob@example.com",
  "NOTIFY_FROM": "transfer@notify.example.com",
  ...
}
```

`npm run lint` checks that they agree, and that the sender is on a subdomain of
`ALLOWED_EMAIL_DOMAIN`, not the apex.

### 6. Set the hostname and team domain

In `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "transfer.example.com", "custom_domain": true }],
"vars": {
  "ALLOWED_EMAIL_DOMAIN": "example.com",          // who may upload
  "PUBLIC_ORIGIN": "https://transfer.example.com", // used for links in emails
  ...
}
```

Wrangler makes the DNS record and the certificate for `transfer.example.com` when you deploy.
Do not make a DNS record for it yourself.

### 7. Set the signing key (secret)

This key signs the download links. Use a long random value and keep it secret.

```bash
openssl rand -hex 32 | npx wrangler secret put SIGNING_KEY
```

If wrangler asks to create the Worker first, say yes.

### 8. Protect the upload page with Cloudflare Access

1. Open the dashboard and go to **Zero Trust**. If this is your first time, choose a
   team name (it becomes `<team>.cloudflareaccess.com`) and the **Free** plan.
2. Go to **Access > Applications > Create new application > Self-hosted**.
3. Name: `transfer`. Add two public hostnames (destinations):
   - Domain `transfer.example.com`, path `send`
   - Domain `transfer.example.com`, path `api/send`
4. Create a policy:
   - Action: **Allow**
   - Include: **Emails ending in** `@example.com`
   - Check the domain spelling. A typo here locks everyone out.
5. Login method: **One-time PIN** is enough (Cloudflare emails a code).
6. Save. Open the application again and copy the **Application Audience (AUD) Tag**.
7. In `wrangler.jsonc`, set:

```jsonc
"ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>",
```

The Worker checks the Access token signature, audience, issuer, expiry and email domain
on every upload request. If these values are wrong or missing, upload is refused.

### 9. Optional: Turnstile

Turnstile adds an invisible human check before a recipient sees the file list.

1. Dashboard > **Turnstile > Add widget**, hostname `transfer.example.com`, mode **Managed**.
2. Put the site key in `wrangler.jsonc` vars as `"TURNSTILE_SITE_KEY": "<site key>"`.
3. Set the secret key:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

### 10. Deploy

```bash
npm run deploy
```

This runs the lint (it refuses any `REPLACE_` placeholder left in `wrangler.jsonc`), the
unit tests, the D1 migrations, then `wrangler deploy`.

### 11. Check the live site

```bash
LIVE_ORIGIN=https://transfer.example.com npm run check:live
```

Expect `live: ok`. It checks `robots.txt` the way crawlers read it, the noindex headers,
the 404 for bots, and that `/send` redirects to Cloudflare Access.

Then do one real test:
1. Open `https://transfer.example.com/send` and sign in with the one-time PIN.
2. Upload a small file and copy the link.
3. Open the link in a private window and download the file.
4. Within a minute or two, the download email arrives (look in spam the first time).

---

## All settings

Set in `wrangler.jsonc` under `vars`, or as secrets where marked:

| Name | Required | Meaning |
|---|---|---|
| `ALLOWED_EMAIL_DOMAIN` | yes | Upload is allowed only for Access emails ending in `@<this>` |
| `ACCESS_TEAM_DOMAIN` | yes | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | yes | AUD tag of the Access application |
| `NOTIFY_TO` | yes | Comma-separated verified addresses that get download emails |
| `NOTIFY_FROM` | yes | Sender, on the Email Routing subdomain |
| `PUBLIC_ORIGIN` | yes | `https://transfer.example.com`, used in email links |
| `TTL_SECONDS` | yes | Life of a transfer. `432000` = 5 days (lint keeps this value) |
| `NOTIFY_COOLDOWN_SECONDS` | no | Minimum gap between emails for one transfer. Default `600` |
| `TURNSTILE_SITE_KEY` | no | Turnstile site key |
| `SIGNING_KEY` | yes, secret | Signs download links |
| `TURNSTILE_SECRET` | no, secret | Turnstile secret key |

Do not set `ALLOW_DEV_AUTH` or `DEV_SENDER_EMAIL` in production. They exist only for local
development in `.dev.vars`, and lint refuses them in `wrangler.jsonc`.

## Local development and checks

```bash
cp .dev.vars.example .dev.vars   # dev sign-in, 10 s expiry
npm run db:local                 # make the local D1 tables (once)
npm run dev                      # local server with local R2, D1 and email simulation
```

```
npm run lint        # project rules (see tools/lint.mjs)
npm test            # zip, CRC-32, Access token unit tests
npm run test:e2e    # end-to-end against the local server on port 8799
npm run tla         # model-check spec/Transfer.tla (needs Java + tla2tools.jar, TLA_JAR=...)
LIVE_ORIGIN=https://transfer.example.com npm run check:live
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Upload page says forbidden after login | `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is wrong, or the email is not on `ALLOWED_EMAIL_DOMAIN`. |
| Login page refuses your email | The Access policy domain has a typo. |
| No download email | A destination address is not verified yet, or `NOTIFY_TO`, `allowed_destination_addresses` and `NOTIFY_FROM` do not agree. See `npx wrangler tail`. |
| Email Routing error 2008 | You tried the apex domain while another provider owns its MX. Use the subdomain call in step 5a. |
| `curl` gets 404 on a link | On purpose: script user agents are treated as bots. Use a browser. |
| Recipient sees "Too many requests" | More than 20 opens a minute from one IP. Wait a minute. Change `ratelimits` in `wrangler.jsonc` if needed. |
| `check:live` says robots.txt allows a path | Something removed `Disallow: /*` from `ROBOTS_TXT` in `src/index.js`. |

## License

MIT. See `LICENSE`.
