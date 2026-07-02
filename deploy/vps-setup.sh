#!/bin/bash
# Dispatch — one-shot VPS setup (Ubuntu 22.04 / 24.04)
# Run as root on a fresh VPS:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/deploy/vps-setup.sh | bash
# Or after cloning:
#   chmod +x deploy/vps-setup.sh && sudo ./deploy/vps-setup.sh
#
# Before running: set your Git repo URL below (or export DISPATCH_REPO_URL).

set -euo pipefail

REPO_URL="${DISPATCH_REPO_URL:-https://github.com/YOUR_USER/dispatch.git}"
APP_DIR="/opt/dispatch"
PORT="${DISPATCH_PORT:-3000}"

echo "==> Dispatch VPS setup"
echo "    Repo: $REPO_URL"
echo "    App dir: $APP_DIR"
echo "    Port: $PORT"

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
ufw allow "${PORT}/tcp"
ufw --force enable

if [[ -d "$APP_DIR/.git" ]]; then
  echo "==> Updating existing install..."
  cd "$APP_DIR"
  git pull
else
  echo "==> Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Installing dependencies (better-sqlite3 may take a minute)..."
npm install --omit=dev

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

pm2 delete dispatch 2>/dev/null || true
if [[ -z "${DISPATCH_USER:-}" || -z "${DISPATCH_PASSWORD:-}" ]]; then
  echo ""
  echo "  WARNING: DISPATCH_USER / DISPATCH_PASSWORD not set — the app is open to anyone with the URL."
  echo "  Re-run with credentials, e.g.:"
  echo "    DISPATCH_USER=admin DISPATCH_PASSWORD='your-secret' $0"
  echo ""
fi
PORT="$PORT" DISPATCH_USER="${DISPATCH_USER:-}" DISPATCH_PASSWORD="${DISPATCH_PASSWORD:-}" \
  pm2 start server.js --name dispatch
pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

PUBLIC_IP="$(curl -fsSL -4 ifconfig.me 2>/dev/null || curl -fsSL -4 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')"

echo ""
echo "============================================"
echo "  Dispatch is running"
echo "============================================"
echo "  App URL:      http://${PUBLIC_IP}:${PORT}"
echo "  DLR webhook:  http://${PUBLIC_IP}:${PORT}/api/dlr"
echo "  Whitelist IP: ${PUBLIC_IP}  (give this to Vacotel)"
echo ""
echo "  Next steps:"
echo "  1. Open the app URL in your browser (login if you set DISPATCH_USER / DISPATCH_PASSWORD)"
echo "  2. Settings → Vacotel credentials"
echo "  3. Turn OFF Test mode → Save"
echo "  4. Test Vacotel connection, then send 1 test SMS"
echo ""
echo "  Logs:  pm2 logs dispatch"
echo "  Restart after git pull:  cd $APP_DIR && git pull && npm install --omit=dev && pm2 restart dispatch"
echo "============================================"
