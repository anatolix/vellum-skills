#!/usr/bin/env python3
"""Compute health summary stats from atop log. Usage: healthstats.py [hours]
Prints a short Russian-language caption for Telegram."""
import subprocess, sys, datetime as dt, shutil

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 24
TODAY = dt.date.today().strftime("%Y%m%d")
YDAY = (dt.date.today() - dt.timedelta(days=1)).strftime("%Y%m%d")

lines = []
for f in (YDAY, TODAY):
    try:
        r = subprocess.run(["atop", "-r", f"/var/log/atop/atop_{f}", "-P", "CPU,CPL,MEM,DSK"],
                           capture_output=True, text=True, timeout=120)
        lines += r.stdout.splitlines()
    except FileNotFoundError:
        pass

cutoff = dt.datetime.now() - dt.timedelta(hours=HOURS)
busy_pct, lavg1, mem_used, mem_total = [], [], [], None
verdict = []
for ln in lines:
    p = ln.split()
    if len(p) < 8 or p[2] == "epoch":
        continue
    t = dt.datetime.fromtimestamp(int(p[2]))
    if t < cutoff:
        continue
    try:
        if p[0] == "CPU":
            sys_, usr, nice, idle, wait, irq, sirq, steal = map(int, p[8:16])
            busy = sys_ + usr + nice + irq + sirq + steal
            total = busy + idle + wait
            if total > 0:
                busy_pct.append(100.0 * busy / total)
        elif p[0] == "CPL":
            lavg1.append(float(p[7]))
        elif p[0] == "MEM":
            page, phys, free, cache, buf, slab = map(int, p[6:12])
            mem_used.append((phys - free - cache - buf - slab) * page / 2**30)
            mem_total = phys * page / 2**30
    except (ValueError, IndexError):
        continue

d = shutil.disk_usage("/")
disk_pct = 100.0 * d.used / d.total

out = []
if busy_pct:
    avg, mx = sum(busy_pct) / len(busy_pct), max(busy_pct)
    out.append(f"CPU: средняя {avg:.0f}%, пик {mx:.0f}%")
    if avg > 70: verdict.append("машина перегружена")
    elif avg > 40: verdict.append("нагрузка высокая")
    else: verdict.append("нагрузка в норме")
    if lavg1:
        la = sum(lavg1) / len(lavg1)
        out.append(f"Load avg (1m): средний {la:.1f}, пик {max(lavg1):.1f} из 4 ядер")
        if la > 4: verdict.append("очередь на CPU")
if mem_used:
    out.append(f"RAM: средняя {sum(mem_used)/len(mem_used):.1f} ГБ, пик {max(mem_used):.1f} из {mem_total:.0f} ГБ")
out.append(f"Диск: {disk_pct:.0f}% занято")
try:
    import json
    st = json.load(open("/home/vellum/logs/snapshot-state.json"))
    now = dt.datetime.now(dt.timezone.utc)
    parts, stale = [], False
    for k, v in sorted(st["latest"].items()):
        age = (now - dt.datetime.fromisoformat(v["created_at"].replace("Z", "+00:00"))).days
        parts.append(f"{k} {age} дн. назад")
        stale |= age > 8
    out.append("Последний снапшот: " + (", ".join(parts) or "нет"))
    if stale or not parts:
        verdict.append("снапшот устарел — проверь бэкапы")
except Exception:
    out.append("Последний снапшот: нет данных")
out.append("")
out.append("Вывод: " + ", ".join(verdict) + "." if verdict else "")
print("\n".join(out))
