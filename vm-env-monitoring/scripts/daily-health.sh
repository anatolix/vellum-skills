#!/bin/bash
# Daily machine health summary: 24h chart + stats, posted to Telegram chat 449271.
# Runs at 09:00 MSK (06:00 UTC) via /etc/cron.d/daily-health.
set -u
export HOME=/home/vellum
export XDG_RUNTIME_DIR=/run/user/1000
export VELLUM_WORKSPACE_DIR=/home/vellum/.local/share/vellum/assistants/juno/.vellum/workspace
source /home/vellum/miniconda3/etc/profile.d/conda.sh
conda activate main

PNG=/var/www/charts/daily.png
python /home/vellum/bin/loadchart.py 24 "$PNG" >/dev/null 2>&1 || exit 1
URL="https://ai.anatolix.net/charts/daily.png?$(date +%s)"

STATS=$(python /home/vellum/bin/healthstats.py 24 2>/dev/null)
ASSISTANT=/home/vellum/.bun/install/global/node_modules/.bin/assistant

# Photo with caption (Telegram captions cap at 1024 chars; stats are short)
RESP=$(/home/vellum/.bun/bin/bun "$ASSISTANT" channels request telegram sendPhoto \
  -X POST -s \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"chat_id":449271,"photo":sys.argv[1],"caption":sys.argv[2]}))' "$URL" "$STATS")" 2>&1)
if echo "$RESP" | grep -qE '"ok": *true'; then
  echo "$(date -Is) sendPhoto OK"
else
  echo "$(date -Is) sendPhoto FAILED: ${RESP:0:500}" >&2
  exit 2
fi
