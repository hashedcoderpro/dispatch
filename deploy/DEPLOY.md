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
| `TRUST_PROXY=1` | Required behind Caddy/nginx (enables Secure cookies) |
| `NODE_ENV=production` | Enforces `CREDENTIALS_KEY` at boot |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CREDENTIALS_KEY
```

Restart after editing:

```bash
cd /opt/dispatch && pm2 restart dispatch
```

## 3. User access model

| Console | URL | Who logs in | Credentials |
|---------|-----|-------------|-------------|
| Send app | `/` | Up to 5–10 users concurrently | Each user's **own** Otus username, portal password, and API token |
| Admin | `/admin` | Up to 2 admins concurrently | Shared `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` |

Each send user has an isolated encrypted credential store. Logging out clears only that browser's session — other users stay connected.

Delivery status comes from the **Otus portal traffic report** (per logged-in user). Campaigns, lead lists, sends, and sender-ID requests are scoped per user. Only admin message templates (`segment_templates`) are shared.

## 4. File permissions

The setup script sets `chmod 600` on `data.sqlite` and `.env`. Verify:

```bash
ls -la /opt/dispatch/data.sqlite /opt/dispatch/.env
```

Back up `data.sqlite` regularly:

```bash
cp /opt/dispatch/data.sqlite /opt/dispatch/backups/data-$(date +%F).sqlite
```

## 5. Multi-user smoke test

After deploy, verify concurrent sessions:

1. Browser A — sign in as `clienta` with clienta's Otus creds.
2. Browser B — sign in as `clientb` with clientb's creds (incognito or different browser).
3. In A, check balance — should show clienta's Otus balance.
4. In B, check balance — should show clientb's balance (different from A).
5. Log out A — B should still work (balance, sender IDs, send).
6. Two admins open `/admin` — both can manage accounts; shared admin session cookies refresh independently per logout.

## 6. Security features enabled

- AES-256-GCM encryption for per-user passwords and API tokens in SQLite
- Admin credentials only in `.env`, not in the database
- HMAC-signed HttpOnly session cookies with `Secure` flag behind HTTPS
- Login rate limiting (30/15min user, 15/15min admin per IP)
- Helmet security headers
- UFW: SSH + 80/443 only (when domain configured)

## 7. Updating

```bash
cd /opt/dispatch
git pull
npm install --omit=dev
pm2 restart dispatch
```

## 9. Cloudflare proxy (orange cloud)

Use **Full (strict)** SSL — never Flexible.

If **admin login works but user login fails** after enabling the orange cloud:

### Diagnose (2 minutes)

1. **Browser DevTools** (F12) → Network → try user sign-in → click `login` request:
   - **403** from Cloudflare → WAF/Bot Fight blocking the request (user login sends `apiId` in JSON; admin does not)
   - **429** → rate limit (`Too many login attempts`)
   - **401** with JSON body → read `error` field (API token vs portal vs 2FA)
   - **200** on login but immediate kick to login screen → session cookie issue

2. **On the VPS**, tail logs while attempting user login:

   ```bash
   pm2 logs dispatch --lines 0
   ```

   Look for `Portal login failed:` or `API token check failed` in the UI error text.

3. **Quick isolation test** — set the `dispatch` DNS record back to **DNS only** (grey cloud) for 2 minutes. If user login works again, the issue is Cloudflare proxy config (not Otus credentials).

### Fixes

**A. Caddy must trust Cloudflare** (so Express sees real client IPs for rate limiting):

Edit `/etc/caddy/Caddyfile`:

```
{
  servers {
    trusted_proxies cloudflare
  }
}

dispatch.otusgw.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then `sudo systemctl reload caddy`.

**B. Express trust proxy** — ensure `.env` has `TRUST_PROXY=1` and restart (`pm2 restart dispatch`). Current code sets `trust proxy` to `true` when this is set.

**C. Cloudflare WAF exception** — Security → WAF → Custom rules → Skip for URI Path equals `/api/auth/login` (or disable Bot Fight Mode temporarily to test).

**D. Rate limit hit** — wait 15 minutes or restart the app (`pm2 restart dispatch` clears in-memory counters).

### Common user-login errors (not Cloudflare)

| UI error | Cause |
|----------|-------|
| `API token check failed` | Wrong API token, or Vacotel IP whitelist (outbound from VPS IP `46.x.x.x`) |
| `Portal login failed: Two-factor authentication is required` | That Otus user has 2FA — disable at otusprivategw.com or use a non-2FA account |
| `Too many login attempts` | Rate limit — see fix D above |

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `CREDENTIALS_KEY environment variable is required` | Set `CREDENTIALS_KEY` in `.env` and restart |
| Admin login: credentials not configured | Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` |
| Portal session expired for one user only | That user re-logs in; others unaffected |
| Delivery stats empty | User must be signed in; check Traffic Report (Otus portal data) |
| Cookies not sticking | Ensure `TRUST_PROXY=1` and you're accessing via HTTPS domain |
| User login fails after orange cloud | See section 9 above |
