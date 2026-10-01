#!/bin/bash
# Start the side shim instance under systemd-run so it outlives the tool shell.
systemctl --user stop shim-mcp-test.service 2>/dev/null; systemctl --user reset-failed shim-mcp-test.service 2>/dev/null
PID=$(systemctl --user show -p MainPID --value claude-shim)
TOK=$(sudo cat /proc/$PID/environ | tr '\0' '\n' | grep '^CLAUDE_CODE_OAUTH_TOKEN=' | cut -d= -f2-)
mkdir -p /tmp/shim-mcp-sessions
systemd-run --user --unit=shim-mcp-test --collect \
  -p WorkingDirectory=/home/vellum/claude-shim \
  -E PATH=/home/vellum/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  -E SHIM_PORT=8318 -E SHIM_TOOL_MODE=mcp -E SHIM_SESSIONS_DIR=/tmp/shim-mcp-sessions \
  -E CLAUDE_CODE_OAUTH_TOKEN="$TOK" \
  /home/vellum/.bun/bin/bun run /home/vellum/claude-shim/server.js >/dev/null
sleep 2
systemctl --user is-active shim-mcp-test.service
ss -ltn | grep -c ':8318 '
