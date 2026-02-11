#!/usr/bin/env bash
# Upload background_music.mp3 to the server. Run from project root.
# You will be prompted for the server password.

set -e
cd "$(dirname "$0")/.."

SERVER="${1:-root@107.173.51.100}"
REMOTE_DIR="serverFiles/automatedYoutubeShortGen/data/background_music"
LOCAL_FILE="temp/background_music.mp3"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "Missing $LOCAL_FILE. Add your background music file there first."
  exit 1
fi

echo "Creating $REMOTE_DIR on server..."
ssh "$SERVER" "mkdir -p $REMOTE_DIR"

echo "Copying background_music.mp3 to server..."
scp "$LOCAL_FILE" "$SERVER:$REMOTE_DIR/background_music.mp3"

echo "Done. Restart the API on the server to use it: docker compose up -d api"
