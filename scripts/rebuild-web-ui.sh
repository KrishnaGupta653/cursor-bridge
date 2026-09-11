#!/usr/bin/env bash
# One-time / occasional: rebuild Flutter web UI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/mobile-app"
flutter build web --release
echo "Done: $ROOT/mobile-app/build/web"
echo "Next: ./scripts/start-web-ui.sh"
