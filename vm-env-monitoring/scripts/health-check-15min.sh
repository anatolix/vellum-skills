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
# CPU: два снимка /proc/stat через 2с; считаем busy всего и busy без nice
read cpu u1 n1 s1 i1 w1 q1 x1 y1 rest < /proc/stat
sleep 2
read cpu u2 n2 s2 i2 w2 q2 x2 y2 rest < /proc/stat
TOT=$(( (u2+n2+s2+i2+w2+q2+x2+y2) - (u1+n1+s1+i1+w1+q1+x1+y1) ))
BUSY=$(( (u2+n2+s2+q1*0+q2+x2+y2+w2) - (u1+n1+s1+q1+x1+y1+w1) ))
BUSY_NONICE=$(( (u2+s2+q2+x2+y2+w2) - (u1+s1+q1+x1+y1+w1) ))
[ "$TOT" -gt 0 ] || TOT=1
CPU_USED=$(( 100*BUSY/TOT ))
CPU_USED_NONICE=$(( 100*BUSY_NONICE/TOT ))
PROBLEMS=""
awk "BEGIN{exit !($LOAD1 > $NPROC*2)}" && PROBLEMS="$PROBLEMS
- Load average 1min: $LOAD1 (при $NPROC ядрах; 5min: $LOAD5)"
[ "$MEM_AVAIL_MB" -lt 1024 ] && PROBLEMS="$PROBLEMS
- Доступно памяти: ${MEM_AVAIL_MB}MB из ${MEM_TOTAL_MB}MB (swap занят: ${SWAP_USED_MB}MB)"
# Алерт только по CPU без nice: nice-фон (TEI и пр.) ядрам не мешает
[ "$CPU_USED_NONICE" -gt 90 ] && PROBLEMS="$PROBLEMS
- CPU занят на ${CPU_USED_NONICE}% без nice (с nice: ${CPU_USED}%)"
CLAUDE_N=$(pgrep -c -x claude || true)
[ "${CLAUDE_N:-0}" -gt 8 ] && PROBLEMS="$PROBLEMS
- Процессов claude CLI: ${CLAUDE_N} (порог 8)"
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

=== claude CLI процессы ===
$(ps -eo pid,etime,pcpu,rss,args | awk '$5 ~ /\/claude$/' | cut -c1-160)

=== df -h ===
$(df -h / /home 2>/dev/null)

=== vmstat 1 3 ===
$(vmstat 1 3)"
  id=$(assistant conversations new "Health alert $(date -u +%H:%M)" --json | jq -r .id)
  assistant conversations wake "$id" --hint "Сработал health check VM ai.anatolix.net. Проанализируй диагностику из external content: назови конкретные процессы-виновники, краткое резюме что происходит и что делать. Затем отправь итог в Telegram через messaging_send (platform: telegram, conversation ID 449271) — по-русски, коротко: ⚠️ заголовок, виновники, цифры, рекомендация. После отправки завершай." --external-content "$SNAP"
  echo "ALERT -> woke $id"
else
  echo "OK: load1=$LOAD1 cpu=${CPU_USED}% cpu_noice=${CPU_USED_NONICE}% mem_avail=${MEM_AVAIL_MB}MB claude=${CLAUDE_N}"
fi
