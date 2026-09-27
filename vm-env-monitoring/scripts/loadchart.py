#!/usr/bin/env python3
"""Render CPU/load/memory chart from atop binary log. Usage: loadchart.py [hours] [out.png]"""
import subprocess, sys, datetime as dt
MSK = dt.timezone(dt.timedelta(hours=3))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 24
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/loadchart.png"
TODAY = dt.date.today().strftime("%Y%m%d")
YDAY = (dt.date.today() - dt.timedelta(days=1)).strftime("%Y%m%d")

lines = []
for f in (YDAY, TODAY):
    try:
        r = subprocess.run(["atop", "-r", f"/var/log/atop/atop_{f}", "-P", "CPU,CPL,MEM"],
                           capture_output=True, text=True, timeout=120)
        lines += r.stdout.splitlines()
    except FileNotFoundError:
        pass

cpu, cpl, mem = [], [], []
for ln in lines:
    p = ln.split()
    if len(p) < 8 or p[2] == "epoch":
        continue
    t = dt.datetime.fromtimestamp(int(p[2]), MSK).replace(tzinfo=None)
    if p[0] == "CPU":
        hertz, ncpu = int(p[6]), int(p[7])
        interval = int(p[5])
        sys_, usr, nice, idle, wait, irq, sirq, steal = map(int, p[8:16])
        busy = sys_ + usr + nice + irq + sirq + steal
        total = busy + idle + wait
        # atop emits one cumulative since-boot sample (huge interval) then
        # per-interval counters; the boot baseline would poison deltas
        if interval <= 300 and total > 0:
            cpu.append((t, busy, total))
    elif p[0] == "CPL":
        cpl.append((t, float(p[7]), float(p[8]), float(p[9])))
    elif p[0] == "MEM":
        page, phys, free, cache, buf, slab = int(p[6]), int(p[7]), int(p[8]), int(p[9]), int(p[10]), int(p[11])
        mem.append((t, (phys - free - cache - buf - slab) * page / 2**30, phys * page / 2**30))

cutoff = dt.datetime.now(MSK).replace(tzinfo=None) - dt.timedelta(hours=HOURS)
cpu = [x for x in cpu if x[0] >= cutoff]
cpl = [x for x in cpl if x[0] >= cutoff]
mem = [x for x in mem if x[0] >= cutoff]
if len(cpu) < 2:
    sys.exit("not enough data")

ts = [x[0] for x in cpu]
busy = [100.0 * x[1] / x[2] for x in cpu]

fig, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
fig.suptitle(f"ai.anatolix.net — last {HOURS:g}h (atop)", fontsize=13)

axes[0].plot(ts, busy, lw=0.9, color="#d62728")
axes[0].set_ylabel("CPU busy %")
axes[0].set_ylim(0, 105)
axes[0].grid(alpha=0.3)

axes[1].plot([x[0] for x in cpl], [x[1] for x in cpl], lw=0.9, label="1m")
axes[1].plot([x[0] for x in cpl], [x[2] for x in cpl], lw=0.9, label="5m")
axes[1].plot([x[0] for x in cpl], [x[3] for x in cpl], lw=0.9, label="15m")
axes[1].set_ylabel("load average")
axes[1].legend(fontsize=8)
axes[1].grid(alpha=0.3)

axes[2].plot([x[0] for x in mem], [x[1] for x in mem], lw=0.9, color="#2ca02c")
if mem:
    axes[2].axhline(mem[0][2], color="gray", ls="--", lw=0.8, label=f"total {mem[0][2]:.0f} GB")
axes[2].set_ylabel("RAM used, GB")
axes[2].legend(fontsize=8)
axes[2].grid(alpha=0.3)
axes[2].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
axes[2].set_xlabel("time (MSK)")

fig.tight_layout()
fig.savefig(OUT, dpi=110)
print(OUT)
