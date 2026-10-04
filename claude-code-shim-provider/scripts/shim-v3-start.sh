#!/bin/bash
# Start claude-shim v3 (server-v3.js, :8320, MCP tool mode) under systemd-run so it outlives the tool shell.
systemctl --user stop shim-v3.service 2>/dev/null; systemctl --user reset-failed shim-v3.service 2>/dev/null
PID=$(systemctl --user show -p MainPID --value claude-shim)
TOK=$(sudo cat /proc/$PID/environ | tr '\0' '\n' | grep '^CLAUDE_CODE_OAUTH_TOKEN=' | cut -d= -f2-)
mkdir -p /home/vellum/claude-shim/sessions
systemd-run --user --unit=shim-v3 --collect \
  -p WorkingDirectory=/home/vellum/claude-shim \
  -p MemoryMax=6G -p MemoryHigh=5G \
  -E PATH=/home/vellum/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  -E SHIM_PORT=8320 -E SHIM_TOOL_MODE=mcp -E SHIM_SESSIONS_DIR=/home/vellum/claude-shim/sessions \
  -E SHIM_FALLBACK_MODEL=sonnet -E SHIM_VERBATIM=1 -E SHIM_CONTEXT_USAGE=1 -E SHIM_PRECOMPUTE_COMPACT=1 \
  -E CLAUDE_CODE_OAUTH_TOKEN="$TOK" \
  /home/vellum/.bun/bin/bun run /home/vellum/claude-shim/server-v3.js >/dev/null
sleep 3
systemctl --user is-active shim-v3.service
ss -ltn | grep -c ':8320 '
journalctl --user -u shim-v3 -n 5 --no-pager -o cat
