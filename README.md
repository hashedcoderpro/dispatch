# Dispatch — Vacotel Bulk SMS Console

A self-hosted bulk SMS campaign tool built against the Vacotel HTTP(s) SMS API.
Node.js + Express + SQLite backend, plain HTML/JS frontend (no build step).

## What it does

- **Quick send** — send test SMS to pasted numbers using admin-configured message templates.
- **Campaigns** — launch a campaign with pasted/uploaded leads and admin-configured campaign
  templates. Preview before sending, with segment counts and estimated cost.
- **Balance** — live balance from each user's Otus account after sign-in.
- **Reports** — per-campaign send logs, error code breakdown, CSV export.
  Delivery stats come from the **Otus portal traffic report** (live, per logged-in user).
- **Multi-user** — each send user sees only their own campaigns, leads, and sends.
  Admin sets shared M/P message templates for all users.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`. Sign in with your Otus username, portal password,
and API token. All sends are live — use the Traffic Report to verify delivery.

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
3. **Per-user accounts** — each send user signs in with their own Otus credentials;
   campaigns and leads are isolated per user. Admin console at `/admin` for templates
   and account management.
4. **Column mapping UI** — right now phone/name/custom columns are auto-detected by
   header name; a manual mapping step would help with messier client CSVs.
5. **Retry logic** — auto-retry sends that fail with transient errors (e.g.
   `UnknownError`) a limited number of times.
6. **A/B performance by message variant** — since each send records which template
   was used, you can already query which of the 50–100 variants gets the best
   delivery rate; a dedicated report view would surface this without a manual query.
7. **Quiet hours** — block sends outside a configured local-time window per
   destination country.
