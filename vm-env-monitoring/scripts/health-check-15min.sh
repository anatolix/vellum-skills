#!/bin/bash
# Body of the Vellum script-mode schedule "health-check-15min".
# Silent when all measured resource thresholds are clear.  A Claude-process
# count is informational only; it is never an alert condition.
set -u

# The *_ROOT/STAT_* hooks are inert in production and let the regression test
# supply fixtures without touching the real VM or invoking real notifications.
PROC_ROOT="${HEALTHCHECK_PROC_ROOT:-/proc}"
STAT1="${HEALTHCHECK_STAT_1:-$PROC_ROOT/stat}"
STAT2="${HEALTHCHECK_STAT_2:-$PROC_ROOT/stat}"

LOAD1=$(cut -d' ' -f1 "$PROC_ROOT/loadavg")
LOAD5=$(cut -d' ' -f2 "$PROC_ROOT/loadavg")
NPROC=$(nproc)
MEM_AVAIL_MB=$(awk '/MemAvailable/{print int($2/1024)}' "$PROC_ROOT/meminfo")
MEM_TOTAL_MB=$(awk '/MemTotal/{print int($2/1024)}' "$PROC_ROOT/meminfo")
SWAP_USED_MB=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print int((t-f)/1024)}' "$PROC_ROOT/meminfo")

# CPU: two samples; preserve the existing non-nice calculation.  Nice CPU is
# reported for visibility but cannot satisfy the CPU alert condition.
read cpu u1 n1 s1 i1 w1 q1 x1 y1 rest < "$STAT1"
sleep 2
read cpu u2 n2 s2 i2 w2 q2 x2 y2 rest < "$STAT2"
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
# Alert only for non-nice CPU above 90%; nice background work is not a breach.
[ "$CPU_USED_NONICE" -gt 90 ] && PROBLEMS="$PROBLEMS
- CPU занят на ${CPU_USED_NONICE}% без nice (с nice: ${CPU_USED}%)"

# Informational only.  In particular, do not add this count to PROBLEMS.
CLAUDE_N=$(pgrep -c -x claude 2>/dev/null || true)
CLAUDE_N="${CLAUDE_N:-0}"

if [ -n "$PROBLEMS" ]; then
  SNAP="=== ПРОБЛЕМЫ (только измеренные resource triggers) ===
$PROBLEMS

=== informational: Claude CLI process count ===
claude CLI processes: $CLAUDE_N (informational only; no count/age/memory alarm)

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
$(vmstat 1 3)

=== measured values ===
load1=$LOAD1 load5=$LOAD5 nproc=$NPROC cpu_total=${CPU_USED}% cpu_no_nice=${CPU_USED_NONICE}% mem_available=${MEM_AVAIL_MB}MB mem_total=${MEM_TOTAL_MB}MB swap_used=${SWAP_USED_MB}MB"
  id=$(assistant conversations new "Health alert $(date -u +%H:%M)" --json | jq -r .id)
  assistant conversations wake "$id" --hint "Сработал health check VM ai.anatolix.net. Автоматическое расследование — READ-ONLY: только анализируй external content и измеренные цифры, без kill/pkill/killall, restart/restarts, process eviction и изменения конфигурации. Легитимные Claude/Codex subagents не являются hung только из-за count, age или memory; число процессов само по себе не основание для kill/restart и не повод рекомендовать kill. Sustained CPU alone is not proof of a typecheck loop. Назови только конкретные процессы и реальные resource triggers, подтверждённые snapshot; не объявляй виновника по одному count/age/memory. При реальном CPU/load/memory breach отправь короткий русский итог с измеренными цифрами в существующий Telegram channel через messaging_send (platform: telegram, conversation ID 449271). Любая remediation возможна только после explicit permission от пользователя; до этого никаких действий, кроме read-only диагностики. После отправки заверши." --external-content "$SNAP"
  echo "ALERT -> woke $id"
else
  echo "OK: load1=$LOAD1 cpu=${CPU_USED}% cpu_no_nice=${CPU_USED_NONICE}% mem_avail=${MEM_AVAIL_MB}MB claude=${CLAUDE_N} (informational)"
fi
