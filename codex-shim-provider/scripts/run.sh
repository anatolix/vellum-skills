#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# v2 = long-lived app-server. v1 is the legacy exec-based fallback.
SERVER="${SHIM_SERVER:-server-v2.js}"
case "$SERVER" in server-v2.js|server.js) ;; *) echo "Unsupported SHIM_SERVER: $SERVER" >&2; exit 2 ;; esac
exec bun run "$SCRIPT_DIR/$SERVER"
