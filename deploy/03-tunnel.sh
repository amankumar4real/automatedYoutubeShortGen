#!/usr/bin/env bash
# Step 3: Expose backend via Cloudflare Tunnel (temporary HTTPS URL).
# Run from project root on the server. Leave this running or run in tmux/screen.

set -e
cd "$(dirname "$0")/.."

CLOUDFLARED="${CLOUDFLARED:-cloudflared}"
URL="${URL:-http://127.0.0.1:4000}"

if ! command -v "$CLOUDFLARED" &>/dev/null; then
  echo "cloudflared not found. Install on Ubuntu:"
  echo "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb"
  echo "  sudo dpkg -i cloudflared.deb"
  echo "  rm -f cloudflared.deb"
  echo "Then run this script again."
  exit 1
fi

echo "Starting tunnel to $URL (backend must be running on that port)."
echo "Use the https://*.trycloudflare.com URL below as your frontend API base."
echo ""
exec "$CLOUDFLARED" tunnel --url "$URL"
