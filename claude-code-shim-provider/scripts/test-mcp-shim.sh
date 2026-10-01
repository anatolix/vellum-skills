#!/bin/bash
# Start a side instance of the patched shim on :8318 (mcp mode) and drive a two-step tool round trip.
cd /home/vellum/claude-shim
PID=$(systemctl --user show -p MainPID --value claude-shim)
export CLAUDE_CODE_OAUTH_TOKEN=$(sudo cat /proc/$PID/environ | tr '\0' '\n' | grep '^CLAUDE_CODE_OAUTH_TOKEN=' | cut -d= -f2-)
export SHIM_PORT=8318 SHIM_TOOL_MODE=mcp SHIM_SESSIONS_DIR=/tmp/shim-mcp-sessions
mkdir -p $SHIM_SESSIONS_DIR



KEY=test-$(date +%s)
TOOLS='[{"type":"function","function":{"name":"bash","description":"Execute a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"},"activity":{"type":"string"},"timeout_seconds":{"type":"number"}},"required":["command","activity"]}}}]'
SYS='{"role":"system","content":"You are a test agent. When asked to run a command, call the bash tool once, then report its output verbatim in one short sentence."}'
U1='{"role":"user","content":"Run `echo hello-from-vellum` and tell me what it printed."}'
echo '== step 1: expect tool_calls'
curl -s -m 60 http://127.0.0.1:8318/v1/chat/completions -H 'content-type: application/json' \
  -d "{\"model\":\"claude-haiku\",\"prompt_cache_key\":\"$KEY\",\"tools\":$TOOLS,\"messages\":[$SYS,$U1]}" > /tmp/step1.sse
grep -oE '"tool_calls":\[.*\]|"finish_reason":"[a-z_]+"|"content":"[^"]{0,60}' /tmp/step1.sse | head -6
TCID=$(grep -oE '"id":"toolu_[A-Za-z0-9]+"' /tmp/step1.sse | head -1 | cut -d'"' -f4)
ARGS=$(grep -oE '"arguments":"[^}]*\}"' /tmp/step1.sse | head -1)
echo "tool_use id=$TCID"
[ -n "$TCID" ] || { echo 'NO TOOL CALL'; tail -20 /dev/null; exit 1; }
echo '== step 2: send tool result, expect final text'
A1="{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"$TCID\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"echo hello-from-vellum\\\",\\\"activity\\\":\\\"test\\\"}\"}}]}"
T1="{\"role\":\"tool\",\"tool_call_id\":\"$TCID\",\"name\":\"bash\",\"content\":\"hello-from-vellum\\n\"}"
sleep 3
curl -s -m 60 http://127.0.0.1:8318/v1/chat/completions -H 'content-type: application/json' \
  -d "{\"model\":\"claude-haiku\",\"prompt_cache_key\":\"$KEY\",\"tools\":$TOOLS,\"messages\":[$SYS,$U1,$A1,$T1]}" > /tmp/step2.sse
grep -oE '"content":"[^"]{0,80}|"finish_reason":"[a-z_]+"|"tool_calls"' /tmp/step2.sse | head -8
echo '== shim log'
grep -E '\[(req|res|sess|mcp|cli|err|warn)' /dev/null | tail -14 | cut -c1-200
