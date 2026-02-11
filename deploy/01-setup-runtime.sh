#!/usr/bin/env bash
# Step 1: Prepare server runtime — Node 18+, deps, build, .env check.
# Run this from project root on the server (e.g. after git clone/pull).

set -e
cd "$(dirname "$0")/.."

echo "[1/4] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Install Node 18+ (e.g. https://nodejs.org or nvm)."
  exit 1
fi
NODE_VER=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo "Node 18+ required; current: $(node -v)"
  exit 1
fi
echo "  Node $(node -v) OK"

echo "[2/4] Installing dependencies..."
npm ci

echo "[3/4] Building backend..."
npm run build

echo "[4/4] Checking .env..."
if [[ ! -f .env ]]; then
  echo "  No .env found. Copy .env.example to .env and set MONGODB_URI, JWT_SECRET, etc."
  echo "  cp .env.example .env && nano .env"
  exit 1
fi
echo "  .env present"

echo ""
echo "Runtime setup done. Next: run ./deploy/02-pm2.sh"
