#!/usr/bin/env bash
# Deploy backend + MongoDB + Cloudflare Tunnel with Docker Compose.
# Run from the project root on your server.

set -e
cd "$(dirname "$0")/.."

echo "Checking Docker..."
command -v docker >/dev/null 2>&1 || { echo "Install Docker: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Install Docker Compose: https://docs.docker.com/compose/install/"; exit 1; }

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and set MONGODB_URI, JWT_SECRET, and API keys."
  exit 1
fi

echo "Building and starting containers..."
docker compose up -d --build

echo ""
echo "Containers started. To get your public HTTPS URL, run:"
echo "  docker compose logs -f tunnel"
echo ""
echo "Copy the https://...trycloudflare.com URL and set it as the API base URL in the frontend."
echo "Verify: curl -s https://YOUR-URL/health"
