#!/bin/bash
# Dispatch — one-shot VPS setup (Ubuntu 22.04 / 24.04)
# Run as root on a fresh VPS:
#   DISPATCH_DOMAIN=dispatch.example.com DISPATCH_REPO_URL=https://github.com/you/dispatch.git bash deploy/vps-setup.sh
#
# Required before production:
#   - DISPATCH_DOMAIN pointing at this server's public IP (A record)
#   - /opt/dispatch/.env filled from .env.example (CREDENTIALS_KEY, ADMIN_*)

set -euo pipefail

REPO_URL="${DISPATCH_REPO_URL:-https://github.com/YOUR_USER/dispatch.git}"
APP_DIR="/opt/dispatch"
PORT="${DISPATCH_PORT:-3000}"
DOMAIN="${DISPATCH_DOMAIN:-}"
APP_USER="${DISPATCH_USER:-dispatch}"

echo "==> Dispatch VPS setup"
echo "    Repo:   $REPO_URL"
echo "    App:    $APP_DIR"
echo "    Port:   $PORT (localhost only when HTTPS enabled)"
echo "    Domain: ${DOMAIN:-none — HTTP on port $PORT}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential ufw

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "==> Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Node $(node -v), npm $(npm -v)"

ufw allow OpenSSH
if [[ -n "$DOMAIN" ]]; then
  ufw allow 80/tcp
  ufw allow 443/tcp
else
  ufw allow "${PORT}/tcp"
  echo "    WARNING: No DISPATCH_DOMAIN — app exposed on HTTP port $PORT (not recommended for production)"
fi
ufw --force enable

if ! id "$APP_USER" &>/dev/null; then
  echo "==> Creating app user: $APP_USER"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER" || true
fi

if [[ -d "$APP_DIR/.git" ]]; then
  echo "==> Updating existing install..."
  cd "$APP_DIR"
  git pull
else
  echo "==> Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing dependencies (better-sqlite3 may take a minute)..."
sudo -u "$APP_USER" npm install --omit=dev

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo ""
  echo "    Created $APP_DIR/.env from template — EDIT IT before using in production:"
  echo "      CREDENTIALS_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, TRUST_PROXY=1"
  echo ""
fi

if [[ -f "$APP_DIR/data.sqlite" ]]; then
  chmod 600 "$APP_DIR/data.sqlite"
  chown "$APP_USER:$APP_USER" "$APP_DIR/data.sqlite"
fi

if [[ -n "$DOMAIN" ]]; then
  echo "==> Installing Caddy for HTTPS..."
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy

  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  reverse_proxy 127.0.0.1:${PORT}
}
EOF
  systemctl enable caddy
  systemctl restart caddy
fi

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

pm2 delete dispatch 2>/dev/null || true
cd "$APP_DIR"
PORT="$PORT" pm2 start server.js --name dispatch
pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

PUBLIC_IP="$(curl -fsSL -4 ifconfig.me 2>/dev/null || curl -fsSL -4 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')"

DLR_HINT="http://${PUBLIC_IP}:${PORT}/api/dlr"
APP_URL="http://${PUBLIC_IP}:${PORT}"
if [[ -n "$DOMAIN" ]]; then
  APP_URL="https://${DOMAIN}"
  DLR_HINT="https://${DOMAIN}/api/dlr"
fi

echo ""
echo "============================================"
echo "  Dispatch is running"
echo "============================================"
echo "  App URL:      ${APP_URL}"
echo "  Admin:        ${APP_URL}/admin"
echo "  DLR webhook:  ${DLR_HINT}"
echo "  Whitelist IP: ${PUBLIC_IP}  (give this to Vacotel)"
echo ""
echo "  Before going live:"
echo "  1. Edit ${APP_DIR}/.env (see .env.example)"
echo "  2. pm2 restart dispatch"
echo "  3. Vacotel DLR URL unchanged unless you add HTTPS/domain or optional DLR_SECRET"
echo "  4. Each send user signs in with their own Otus credentials"
echo "  5. Admins sign in at /admin with the shared ADMIN_* credentials"
echo ""
echo "  Logs:    pm2 logs dispatch"
echo "  Update:  cd $APP_DIR && git pull && npm install --omit=dev && pm2 restart dispatch"
echo "  Docs:    deploy/DEPLOY.md"
echo "============================================"
