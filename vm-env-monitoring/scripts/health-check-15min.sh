#!/bin/bash
# Body of the Vellum script-mode schedule "health-check-15min" (cron */15, quiet, timeout 60s,
# inference profile kimi-k3-medium for the woken alert conversation).
# Silent when OK. On threshold breach: collects diagnostics and wakes a fresh conversation
# that analyses them and sends a short Russian summary to Telegram.
set -u
LOAD1=$(cut -d' ' -f1 /proc/loadavg)
LOAD5=$(cut -d' ' -f2 /proc/loadavg)
NPROC=$(nproc)
MEM_AVAIL_MB=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
MEM_TOTAL_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_USED_MB=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)
CPU_IDLE=$(top -bn1 | awk -F',' '/%Cpu/{for(i=1;i<=NF;i++) if($i ~ /id/){gsub(/[^0-9.]/,"",$i); print $i}}')
CPU_USED=$(awk "BEGIN{printf \"%.0f\", 100-$CPU_IDLE}")
PROBLEMS=""
awk "BEGIN{exit !($LOAD1 > $NPROC*2)}" && PROBLEMS="$PROBLEMS
- Load average 1min: $LOAD1 (при $NPROC ядрах; 5min: $LOAD5)"
[ "$MEM_AVAIL_MB" -lt 1024 ] && PROBLEMS="$PROBLEMS
- Доступно памяти: ${MEM_AVAIL_MB}MB из ${MEM_TOTAL_MB}MB (swap занят: ${SWAP_USED_MB}MB)"
[ "$CPU_USED" -gt 90 ] && PROBLEMS="$PROBLEMS
- CPU занят на ${CPU_USED}%"
if [ -n "$PROBLEMS" ]; then
  SNAP="=== ПРОБЛЕМЫ ===
$PROBLEMS

=== uptime ===
$(uptime)

=== free -m ===
$(free -m)

=== top (1 снимок) ===
$(top -bn1 | head -n 20)

=== ps top-10 по CPU ===
$(ps aux --sort=-%cpu | head -n 11)

=== ps top-10 по MEM ===
$(ps aux --sort=-%mem | head -n 11)

=== df -h ===
$(df -h / /home 2>/dev/null)

=== vmstat 1 3 ===
$(vmstat 1 3)"
  id=$(assistant conversations new "Health alert $(date -u +%H:%M)" --json | jq -r .id)
  assistant conversations wake "$id" --hint "Сработал health check VM. Проанализируй диагностику из external content: назови конкретные процессы-виновники, краткое резюме что происходит и что делать. Затем отправь итог в Telegram через messaging_send (platform: telegram, conversation ID <CHAT_ID>) — по-русски, коротко: ⚠️ заголовок, виновники, цифры, рекомендация. После отправки завершай." --external-content "$SNAP"
  echo "ALERT -> woke $id"
else
  echo "OK: load1=$LOAD1 cpu=${CPU_USED}% mem_avail=${MEM_AVAIL_MB}MB"
fi
