#!/usr/bin/env bash
# Step 2: Run backend with PM2 and persist across reboot.
# Run from project root on the server after 01-setup-runtime.sh.

set -e
cd "$(dirname "$0")/.."

echo "[1/4] Checking PM2..."
if ! command -v pm2 &>/dev/null; then
  echo "PM2 not found. Install: npm i -g pm2"
  exit 1
fi

echo "[2/4] Starting backend with PM2 (production)..."
NODE_ENV=production pm2 start deploy/ecosystem.config.cjs --env production

echo "[3/4] Saving process list..."
pm2 save

echo "[4/4] Enabling startup on boot..."
pm2 startup || true
echo "  If PM2 printed a 'sudo env PATH=...' command, run it so the app restarts on reboot."

echo ""
echo "Backend is running. Check: pm2 status && curl -s http://127.0.0.1:4000/health"
echo "Next: run ./deploy/03-tunnel.sh to get an HTTPS URL"
