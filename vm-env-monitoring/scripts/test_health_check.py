#!/usr/bin/env python3
"""Regression tests for the isolated health-check proposal.

All probes and notification calls are fake commands in a temporary PATH.
No real wake, Telegram send, alert, process inspection, or VM mutation occurs.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "health-check-15min.sh"


def write(path: Path, text: str, executable: bool = False) -> None:
    path.write_text(text, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def stat_line(user: int, nice: int, system: int, idle: int) -> str:
    return f"cpu {user} {nice} {system} {idle} 0 0 0 0 0 0\n"


def run_case(
    tmp: Path,
    name: str,
    *,
    load1: str,
    mem_available: int,
    stat1: str,
    stat2: str,
    claude_count: int,
    expect_alert: bool,
) -> tuple[str, str]:
    case = tmp / name
    proc = case / "proc"
    fakebin = case / "bin"
    proc.mkdir(parents=True)
    fakebin.mkdir()
    write(proc / "loadavg", f"{load1} 0.10 0.05 1/100 1\n")
    write(
        proc / "meminfo",
        f"MemTotal:       8192000 kB\n"
        f"MemAvailable:   {mem_available * 1024} kB\n"
        "SwapTotal:      1048576 kB\n"
        "SwapFree:        524288 kB\n",
    )
    write(proc / "stat.1", stat1)
    write(proc / "stat.2", stat2)

    write(fakebin / "nproc", '#!/bin/sh\nprintf "4\\n"\n', True)
    write(
        fakebin / "pgrep",
        '#!/bin/sh\nprintf "%s\\n" "$FAKE_CLAUDE_N"\n',
        True,
    )
    write(fakebin / "sleep", "#!/bin/sh\nexit 0\n", True)
    for command in ("uptime", "free", "top", "ps", "df", "vmstat"):
        write(
            fakebin / command,
            f'#!/bin/sh\nprintf "fake {command} output\\n"\n',
            True,
        )
    write(
        fakebin / "assistant",
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n'
        'if [ "$1" = conversations ] && [ "$2" = new ]; then\n'
        '  printf \'{"id":"fake-health-conversation"}\\n\'\n'
        "fi\n",
        True,
    )
    log = case / "commands.log"
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fakebin}:{env['PATH']}",
            "HEALTHCHECK_PROC_ROOT": str(proc),
            "HEALTHCHECK_STAT_1": str(proc / "stat.1"),
            "HEALTHCHECK_STAT_2": str(proc / "stat.2"),
            "FAKE_CLAUDE_N": str(claude_count),
            "FAKE_LOG": str(log),
        }
    )
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"{name}: script exited {result.returncode}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    command_log = log.read_text(encoding="utf-8") if log.exists() else ""
    got_alert = "conversations wake" in command_log
    if got_alert != expect_alert:
        raise AssertionError(
            f"{name}: expected alert={expect_alert}, got alert={got_alert}\n"
            f"stdout={result.stdout}\ncommands={command_log}"
        )
    return result.stdout, command_log


def main() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert "awk \"BEGIN{exit !($LOAD1 > $NPROC*2)}\"" in text
    assert '[ "$MEM_AVAIL_MB" -lt 1024 ]' in text
    assert '[ "$CPU_USED_NONICE" -gt 90 ]' in text
    assert 'CLAUDE_N.*PROBLEMS' not in text
    assert '-gt 8' not in text
    assert "порог 8" not in text

    with tempfile.TemporaryDirectory(prefix="health-check-test-", dir=ROOT) as raw:
        tmp = Path(raw)
        low_cpu_1 = stat_line(100, 0, 100, 800)
        low_cpu_2 = stat_line(101, 0, 101, 898)
        high_cpu_1 = stat_line(100, 0, 100, 900)
        high_cpu_2 = stat_line(195, 0, 100, 905)

        # Many legitimate subagents with healthy resources must stay silent.
        stdout, commands = run_case(
            tmp,
            "high-count-healthy",
            load1="0.10",
            mem_available=4096,
            stat1=low_cpu_1,
            stat2=low_cpu_2,
            claude_count=42,
            expect_alert=False,
        )
        assert "claude=42" in stdout
        assert commands == "", commands

        cases = (
            ("high-cpu", "0.10", 4096, high_cpu_1, high_cpu_2),
            ("high-load", "9.00", 4096, low_cpu_1, low_cpu_2),
            ("low-memory", "0.10", 512, low_cpu_1, low_cpu_2),
        )
        for name, load, mem, first, second in cases:
            _, commands = run_case(
                tmp,
                name,
                load1=load,
                mem_available=mem,
                stat1=first,
                stat2=second,
                claude_count=42,
                expect_alert=True,
            )
            hint = commands.split("conversations wake ", 1)[1]
            for required in (
                "READ-ONLY",
                "Claude/Codex",
                "count",
                "age",
                "memory",
                "kill/pkill/killall",
                "restart/restarts",
                "process eviction",
                "typecheck loop",
                "explicit permission",
                "conversation ID 449271",
            ):
                assert required in hint, (name, required, hint)
            problems = hint.split("=== ПРОБЛЕМЫ", 1)[1].split(
                "=== informational", 1
            )[0]
            assert "claude" not in problems.lower()
            assert "Telegram" in hint

        # Exact boundaries remain non-triggering: >90, >2*nproc, and <1024.
        _, commands = run_case(
            tmp,
            "exact-boundaries",
            load1="8.00",
            mem_available=1024,
            stat1=stat_line(100, 0, 100, 900),
            stat2=stat_line(190, 0, 100, 910),
            claude_count=99,
            expect_alert=False,
        )
        assert commands == "", commands

    print("PASS: bash behavior, thresholds, informational count, diagnostics, and READ-ONLY hint")


if __name__ == "__main__":
    main()
