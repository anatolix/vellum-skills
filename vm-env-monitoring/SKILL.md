---
name: "VM environment setup and monitoring"
description: "Set up and monitor a self-hosted Vellum VM: nginx reverse proxy (streaming-safe) with a public /charts/ dir, atop history at 60s, a 15-minute silent-unless-broken health check (script-mode schedule, LLM only on alert), and a morning Telegram report with a 24h CPU/load/RAM chart plus stats and backup age."
metadata:
  vellum:
    emoji: 🩺
    activation-hints:
      - set up a new self-hosted Vellum VM (nginx, TLS, monitoring)
      - add health monitoring / alerts / daily load report for a VM
      - streamed text lags in clients and catches up after switching chats
      - restore or audit the monitoring stack after an upgrade or rebuild
    avoid-when:
      - full observability stack (Prometheus/Grafana) is wanted
      - monitoring remote machines the assistant cannot run shell on
    category: system
---

# VM environment setup and monitoring

Reference implementation: ai.anatolix.net (Ubuntu 24.04, 4 vCPU / 16 GB, Vellum gateway on 127.0.0.1:7840).
Placeholders: `<HOST>` (domain), `<CHAT_ID>` (Telegram chat for reports, reference value 449271).

## Layout

| Piece | Where | Runs |
|---|---|---|
| nginx site | `/etc/nginx/sites-available/<HOST>` → `references/nginx-site.conf` | always |
| atop history | `/etc/default/atop` → `references/etc-default-atop`, logs `/var/log/atop/` | always, 60 s samples, 28 days |
| 15-min health check | Vellum schedule `health-check-15min`, body `scripts/health-check-15min.sh` | `*/15 * * * *` |
| Morning report | `/etc/cron.d/daily-health` → `scripts/daily-health.sh` (+ `loadchart.py`, `healthstats.py`) | 06:00 UTC = 09:00 MSK |
| Other morning LLM schedules | release watch 08:30, fail2ban digest 09:00 (Asia/Baghdad) → `references/morning-llm-schedules.txt` | daily |

## 1. nginx

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp references/nginx-site.conf /etc/nginx/sites-available/<HOST>   # edit placeholders
sudo ln -sf /etc/nginx/sites-available/<HOST> /etc/nginx/sites-enabled/<HOST>
sudo mkdir -p /var/www/charts && sudo chown vellum: /var/www/charts
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <HOST>
```

Rules learned the hard way:
- **`proxy_buffering off` + `proxy_cache off` in `location /` is mandatory.** Without it nginx buffers the reply stream: text in web/iOS clients stalls and only catches up when you switch chats (history is re-fetched by a normal request). WebSocket upgrade alone does not cover it.
- **Edit the file nginx actually loads.** Resolve it with `readlink -f /etc/nginx/sites-enabled/<HOST>` or `sudo nginx -T | grep '^# configuration file'`. A plain `grep -rl /etc/nginx` happily matches `*.bak*` copies in sites-available first.
- Back up before every edit (`sudo cp -a F ~/nginx-backup-$(date +%Y%m%d-%H%M%S).conf`), then `nginx -t` → `reload`, and roll back automatically if the test fails.
- Certbot rewrites the server block. After any certbot run diff against the backup: we once lost 5 custom directives this way and had to dig them out of a disk snapshot.
- Keep `.bak` files out of `sites-enabled` (nginx loads everything there).

## 2. atop

```bash
sudo apt install -y atop
sudo sed -i 's/^LOGINTERVAL=.*/LOGINTERVAL=60/; s/^LOGGENERATIONS=.*/LOGGENERATIONS=28/' /etc/default/atop
sudo systemctl enable --now atop atopacct && sudo systemctl restart atop
```

Parsing `atop -r /var/log/atop/atop_YYYYMMDD -P CPU,CPL,MEM,DSK`:
- CPU fields after `label host epoch date time interval`: `hertz ncpu sys usr nice idle wait irq softirq steal guest`. Busy = sys+usr+nice+irq+softirq+steal; total = busy+idle+wait.
- The first CPU sample of each file is a since-boot cumulative baseline (huge interval) — drop samples with interval > 300.
- MEM: `page phys free cache buf slab …`; used = (phys−free−cache−buf−slab)·page.
- CPL field 7/8/9 = load 1/5/15.
- Read yesterday's + today's file to cover a rolling 24 h window. Files rotate at midnight (`atop-rotate.timer`).

## 3. 15-minute health check (script-mode schedule)

Script mode = no LLM on healthy runs, cost ≈ 0 at 96 runs/day. Create with the `schedule` skill:

```json
{ "name": "health-check-15min", "syntax": "cron", "expression": "*/15 * * * *",
  "timezone": "Europe/Moscow", "mode": "script", "quiet": true, "timeout_ms": 60000,
  "script": "<contents of scripts/health-check-15min.sh>" }
```

Set the schedule's inference profile to a cheap tool-capable model (reference: kimi-k3-medium) — it only matters for the alert conversation.

Thresholds: load1 > 2×nproc, MemAvailable < 1024 MB, CPU busy **excluding nice** > 90 % (two /proc/stat samples 2 s apart; nice-only load like a reniced TEI saturating idle cores is normal and must NOT alert — the alert line reports both numbers). Also alerts when more than 8 `claude` CLI processes run (`pgrep -c -x claude`: the claude-agent-sdk binaries spawned by claude-shim; the snapshot lists them with etime/CPU/RSS). Gotcha: /proc/stat has 10 numeric fields — `read` needs a trailing catch-all var or arithmetic breaks. On breach it snapshots uptime/free/top/ps/df/vmstat, opens a new conversation (`assistant conversations new` + `wake --external-content`), and that conversation names the culprits and sends a short Russian ⚠️ summary to Telegram. OK runs just print one line to the schedule log.

Verify: `assistant schedules get <id>` → Last status ok; test the alert path once by temporarily lowering a threshold.

## 4. Morning report (system cron, 09:00 MSK)

```bash
sudo apt install -y jq; conda activate main && pip install matplotlib   # env used by daily-health.sh
cp scripts/{daily-health.sh,loadchart.py,healthstats.py} /home/vellum/bin/ && chmod +x /home/vellum/bin/*
mkdir -p /home/vellum/logs
sudo cp references/cron.d-daily-health /etc/cron.d/daily-health
```

Flow: `loadchart.py 24 /var/www/charts/daily.png` (3 panels: CPU busy %, load 1/5/15, RAM) → `healthstats.py 24` builds the caption (CPU avg/peak, load avg/peak, RAM avg/peak, disk %, age of latest VM snapshot from `/home/vellum/logs/snapshot-state.json`, stale > 8 days, plus a one-line verdict) → Telegram `sendPhoto` via `assistant channels request telegram sendPhoto` with the public URL `https://<HOST>/charts/daily.png?<ts>` (cache-buster). Success is checked by `"ok": true` in the response; failures go to `/home/vellum/logs/daily-health.log`.

Gotchas:
- cron has no user session: the script exports `HOME`, `XDG_RUNTIME_DIR=/run/user/1000`, `VELLUM_WORKSPACE_DIR` and calls `assistant` through the full bun path.
- Telegram fetches the photo by URL, so `/charts/` must be public over HTTPS.
- Caption limit is 1024 chars — keep stats terse.
- Ad-hoc chart: `loadchart.py 6 /tmp/x.png`.

## 5. Other morning triggers

`references/morning-llm-schedules.txt` has the full definitions of the two execute-mode (LLM) morning schedules: **vellum release watch** (08:30 Asia/Baghdad, checks for new Vellum releases) and **fail2ban daily digest** (09:00 Asia/Baghdad). Recreate them with the `schedule` skill from those definitions.

Related: weekly VM snapshot (`hostvds-weekly-snapshot` skill) writes `snapshot-state.json`, which the morning report reads.

## Health audit checklist

```bash
systemctl is-active nginx atop atopacct
sudo nginx -T | grep -A3 'proxy_pass http://127.0.0.1:7840'   # buffering off present?
ls -la /var/log/atop | tail -3                                 # today's file growing?
assistant schedules list                                       # health-check-15min enabled, last ok
tail -5 /home/vellum/logs/daily-health.log                     # last sendPhoto OK
cat /etc/cron.d/daily-health
```
After a Vellum upgrade or VM rebuild, run the checklist; the schedules live in the assistant DB, the rest lives on the VM.
