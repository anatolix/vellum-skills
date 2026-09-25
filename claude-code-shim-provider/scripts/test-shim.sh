#!/bin/bash
# Three-stage shim test: plain content, tool_call emission, tool_result consumption.
# Usage: ./test-shim.sh [model]   (default claude-sonnet — faster/cheaper than opus)
M="${1:-claude-sonnet}"
URL=http://127.0.0.1:8317/v1/chat/completions
TOOLS='[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]'
run() { echo "=== $1"; curl -s -m 180 "$URL" -H 'Content-Type: application/json' -d "$2" \
  | grep '^data:' | grep -v DONE | sed 's/^data: //' | jq -c '.choices[0] | {delta, finish_reason}'; }
run t1-plain "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Ответь одним словом: столица Франции?\"}]}"
run t2-toolcall "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Какая сейчас погода в Москве? Используй инструмент.\"}],\"tools\":$TOOLS}"
run t3-toolresult "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Какая сейчас погода в Москве? Используй инструмент.\"},{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Москва\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_abc\",\"name\":\"get_weather\",\"content\":\"{\\\"temp_c\\\": 7, \\\"condition\\\": \\\"дождь\\\"}\"}],\"tools\":$TOOLS}"
