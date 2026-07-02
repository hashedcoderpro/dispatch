# Dispatch — Vacotel Bulk SMS Console

A self-hosted bulk SMS campaign tool built against the Vacotel HTTP(s) SMS API.
Node.js + Express + SQLite backend, plain HTML/JS frontend (no build step).

## What it does

- **Lead lists** — upload a CSV of 500–1,000 contacts. Phone/name/custom columns are
  auto-detected. Numbers are normalized (no `+`, deduped, validated) on import.
- **Message rosters** — paste or upload 50–100 message variants. Campaigns rotate
  through them (sequential or random) so contacts don't get identical text.
  Supports `{name}`, `{phone}`, `{custom1}`, `{custom2}` merge fields.
- **Campaigns** — pair a list + a roster, preview exactly what will be sent (with
  segment counts and estimated cost) before committing, then send.
- **Balance tracking** — Vacotel's API doesn't expose account balance, so balance is
  tracked manually: top it up, set a rate per SMS segment per campaign, and the app
  deducts automatically as messages send (using the real segment count returned by
  the API, not just character count).
- **Reports** — per-campaign and account-wide delivery reports, error code
  breakdown, CSV export. A `/api/dlr` webhook endpoint ingests Vacotel's delivery
  receipts and matches them back to sends by vendor message ID.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`. Go to **Settings** and enter your Vacotel username/
password. Leave **Test mode** on until you're ready to send real messages — it
simulates the API so you can safely try the whole flow first.

## Access protection (username / password)

By default the app is open to anyone who can reach the URL. To require a login,
set these environment variables before starting the server:

| Variable | Purpose |
|----------|---------|
| `DISPATCH_USER` | Username for the browser login prompt |
| `DISPATCH_PASSWORD` | Password for the browser login prompt |

**Local (PowerShell):**

```powershell
$env:DISPATCH_USER = "admin"
$env:DISPATCH_PASSWORD = "your-secret-password"
npm start
```

**Production (PM2):**

```bash
DISPATCH_USER=admin DISPATCH_PASSWORD=your-secret-password pm2 start server.js --name dispatch
```

Or persist them in a PM2 ecosystem file / systemd unit. Once set, visiting the
app shows a browser login dialog; API calls from the UI reuse those credentials
automatically.

The Vacotel DLR webhook (`/api/dlr`) stays **unauthenticated** so Vacotel can
still push delivery receipts without credentials.

## Pointing Vacotel's DLR callback at this app

Vacotel needs to reach `/api/dlr` on a public URL. Options:
- Deploy the app on a small VPS / server with a public IP or domain (recommended
  for production — see below).
- For local testing, use a tunnel like `ngrok http 3000` and give Vacotel the
  resulting `https://xxxx.ngrok.app/api/dlr` URL.

The Settings page shows the exact URL to hand to Vacotel once you know your host.

## Deploying for real use

Any small VPS (DigitalOcean, Linode, a $5–10/mo box) works:

1. Copy this folder to the server, `npm install`, then run it behind a process
   manager: `npm i -g pm2 && pm2 start server.js --name dispatch`.
2. Put nginx (or Caddy) in front for HTTPS and point your domain at it.
3. Set `vacotel_base_url` to `https://api.vacotel.net` if Vacotel supports HTTPS
   (confirm with them — the sample docs show `http://`).
4. Firewall the box normally; the SQLite file (`data.sqlite`) holds all leads,
   messages, and send history, so back it up periodically (`cp data.sqlite backup/`).

## Notes on the API integration

- Sends are made one-by-one (not the multi-destination batch form) because each
  contact gets personalized text — the batch endpoint sends identical text to
  multiple numbers in one call, which doesn't fit the rotation requirement.
- `dataCoding` is auto-detected per message: GSM-7 (`0`) if the text only uses
  standard characters, otherwise Unicode (`8`) — this matters because it changes
  the per-segment character limit (160 vs 70) and therefore cost.
- A configurable throttle (default 300ms between sends) paces the send loop —
  useful both to stay within any rate limit Vacotel enforces and to avoid
  triggering carrier-side spam filters from a sudden burst.
- Vacotel error codes (`-1` NoMessage through `-11` InvalidInstanceConnection) are
  mapped to readable labels in the Reports error breakdown.

## Suggested next improvements

Roughly in priority order:

1. **Opt-out / STOP handling** — add an inbound SMS or keyword listener so replies
   of STOP/UNSUBSCRIBE flag a lead as opted out (the `opted_out` column already
   exists in the schema; campaigns already skip opted-out leads). This matters for
   TCPA/compliance, not just niceness.
2. **Scheduling** — let a campaign be scheduled for a future time or spread over a
   window (e.g. "send over 4 hours") instead of only "send now."
3. **Per-user accounts / roles** — right now anyone with access to the app can send
   and see the API password. Add login + an admin-only settings page if more than
   one person will use it.
4. **Column mapping UI** — right now phone/name/custom columns are auto-detected by
   header name; a manual mapping step would help with messier client CSVs.
5. **Retry logic** — auto-retry sends that fail with transient errors (e.g.
   `UnknownError`) a limited number of times.
6. **A/B performance by message variant** — since each send records which template
   was used, you can already query which of the 50–100 variants gets the best
   delivery rate; a dedicated report view would surface this without a manual query.
7. **Quiet hours** — block sends outside a configured local-time window per
   destination country.
