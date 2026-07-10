# Dispatch — production deployment checklist

Use this after running [`vps-setup.sh`](vps-setup.sh) or when upgrading an existing install.

## 1. DNS

Point an A record at your VPS public IP, e.g. `dispatch.yourdomain.com` → `203.0.113.10`.

Re-run setup with the domain:

```bash
export DISPATCH_DOMAIN=dispatch.yourdomain.com
export DISPATCH_REPO_URL=https://github.com/your-org/dispatch.git
sudo -E bash deploy/vps-setup.sh
```

Caddy obtains a Let's Encrypt certificate automatically. Port 3000 is **not** exposed publicly when a domain is configured.

## 2. Environment file

On the VPS, edit `/opt/dispatch/.env` (copy from `.env.example`):

| Variable | Purpose |
|----------|---------|
| `CREDENTIALS_KEY` | 64-char hex — encrypts per-user Otus passwords/API tokens in SQLite |
| `ADMIN_USERNAME` | Shared Otus admin portal username (both admins use this) |
| `ADMIN_PASSWORD` | Shared Otus admin portal password |
| `DLR_SECRET` | **Optional** — only if you want webhook token auth (requires updating Vacotel's callback URL) |
| `TRUST_PROXY=1` | Required behind Caddy/nginx (enables Secure cookies) |
| `NODE_ENV=production` | Enforces `CREDENTIALS_KEY` at boot |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CREDENTIALS_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # DLR_SECRET
```

Restart after editing:

```bash
cd /opt/dispatch && pm2 restart dispatch
```

## 3. Vacotel DLR webhook

**No Vacotel changes needed** if you leave `DLR_SECRET` unset in `.env`. Whatever callback URL Vacotel already has (e.g. `http://YOUR_IP:3000/api/dlr`) keeps working as before.

Only if you later set `DLR_SECRET` would you need to ask Vacotel to append `?token=YOUR_DLR_SECRET` to that URL. That is optional hardening, not required for deploy.

If you move to HTTPS with a domain, you would eventually update the host part of the URL with Vacotel (e.g. `https://dispatch.yourdomain.com/api/dlr`) — same path, no token unless you enable `DLR_SECRET`.

## 4. User access model

| Console | URL | Who logs in | Credentials |
|---------|-----|-------------|-------------|
| Send app | `/` | Up to 5–10 users concurrently | Each user's **own** Otus username, portal password, and API token |
| Admin | `/admin` | Up to 2 admins concurrently | Shared `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` |

Each send user has an isolated encrypted credential store and per-user test mode. Logging out clears only that browser's session — other users stay connected.

Campaigns and lead lists remain **shared** across all send users (by design).

## 5. File permissions

The setup script sets `chmod 600` on `data.sqlite` and `.env`. Verify:

```bash
ls -la /opt/dispatch/data.sqlite /opt/dispatch/.env
```

Back up `data.sqlite` regularly:

```bash
cp /opt/dispatch/data.sqlite /opt/dispatch/backups/data-$(date +%F).sqlite
```

## 6. Multi-user smoke test

After deploy, verify concurrent sessions:

1. Browser A — sign in as `clienta` with clienta's Otus creds.
2. Browser B — sign in as `clientb` with clientb's creds (incognito or different browser).
3. In A, check balance — should show clienta's Otus balance.
4. In B, check balance — should show clientb's balance (different from A).
5. Log out A — B should still work (balance, sender IDs, send).
6. Toggle test mode in A — should not change B's test mode indicator.
7. Two admins open `/admin` — both can manage accounts; shared admin session cookies refresh independently per logout.

## 7. Security features enabled

- AES-256-GCM encryption for per-user passwords and API tokens in SQLite
- Admin credentials only in `.env`, not in the database
- HMAC-signed HttpOnly session cookies with `Secure` flag behind HTTPS
- Login rate limiting (30/15min user, 15/15min admin per IP)
- Helmet security headers
- DLR webhook token authentication
- UFW: SSH + 80/443 only (when domain configured)

## 8. Updating

```bash
cd /opt/dispatch
git pull
npm install --omit=dev
pm2 restart dispatch
```

## 9. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `CREDENTIALS_KEY environment variable is required` | Set `CREDENTIALS_KEY` in `.env` and restart |
| Admin login: credentials not configured | Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` |
| Portal session expired for one user only | That user re-logs in; others unaffected |
| DLR not updating | Confirm Vacotel URL includes correct `?token=`; check `pm2 logs dispatch` |
| Cookies not sticking | Ensure `TRUST_PROXY=1` and you're accessing via HTTPS domain |
