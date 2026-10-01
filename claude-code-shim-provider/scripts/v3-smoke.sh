#!/bin/bash
# Smoke test v3: plain chat (haiku, keyed) + tool call round trip (mcp mode)
B=http://127.0.0.1:8320
curl -s $B/v1/models | head -c 300; echo
echo '=== plain chat, keyed ==='
curl -s -N $B/v1/chat/completions -H 'content-type: application/json' -H 'x-shim-max-budget-usd: 0.5' -d '{"model":"claude-haiku","prompt_cache_key":"v3-smoke-1","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Say exactly: v3 alive"}]}' | grep -E '"content"|usage' | cut -c1-900
echo; echo '=== second turn same key (cache) ==='
curl -s -N $B/v1/chat/completions -H 'content-type: application/json' -d '{"model":"claude-haiku","prompt_cache_key":"v3-smoke-1","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Say exactly: v3 alive"},{"role":"assistant","content":"v3 alive"},{"role":"user","content":"And now: still alive"}]}' | grep -E 'usage' | cut -c1-900
echo; echo '=== tool call (mcp) ==='
curl -s -N $B/v1/chat/completions -H 'content-type: application/json' -d '{"model":"claude-haiku","prompt_cache_key":"v3-smoke-2","tools":[{"type":"function","function":{"name":"get_time","description":"Current time","parameters":{"type":"object","properties":{"tz":{"type":"string"}}}}}],"messages":[{"role":"system","content":"Use tools when asked."},{"role":"user","content":"What time is it in Moscow? Use the tool."}]}' | grep -E 'tool_calls' | cut -c1-500
echo; echo '=== status ==='
curl -s $B/chats | cut -c1-600; echo
journalctl --user -u shim-v3 -n 25 --no-pager -o cat | cut -c1-200
