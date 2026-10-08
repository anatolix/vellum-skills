#!/usr/bin/env python3
"""Native exec yields between HTTP requests. Fake app-server; no real model."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


def fake_server():
    lock = threading.Lock()
    pending = {}
    counter = 0

    def send(value):
        with lock:
            print(json.dumps(value), flush=True)

    def complete(tid):
        send({"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": "OK " + tid}})
        send({"method": "turn/completed", "params": {"threadId": tid, "turn": {"id": "turn-" + tid, "status": "completed"}}})

    def call(tid, mid, name, value):
        with lock:
            pending[mid] = tid
            print(json.dumps({"id": mid, "method": "item/tool/call", "params": {
                "threadId": tid, "tool": name, "callId": "cli-" + str(mid),
                "arguments": {"value": value}}}), flush=True)

    def later(tid, base, mode):
        if mode == "cancel":
            time.sleep(.7)
            call(tid, base, "bash", "FIRST")
        time.sleep(1.1)  # well outside the shim's 300ms coalescing window
        call(tid, base + 1, "host_file_read" if mode == "unavailable" else "ui_show", "LATE_CARD")
        call(tid, base + 2, "remember", "LATE_NOTE")

    for line in sys.stdin:
        m = json.loads(line)
        with open(os.environ["FAKE_CODEX_CAPTURE"], "a") as f:
            f.write(json.dumps(m) + "\n")
        method, mid, p = m.get("method"), m.get("id"), m.get("params", {})
        if method in ("initialize", "skills/list"):
            send({"id": mid, "result": {}})
        elif method == "model/list":
            send({"id": mid, "result": {"data": [{"id": "mock-model"}]}})
        elif method == "thread/start":
            counter += 1
            send({"id": mid, "result": {"thread": {"id": "thread-" + str(counter)}}})
        elif method == "thread/resume":
            send({"id": mid, "result": {"thread": {"id": p["threadId"]}}})
        elif method == "turn/start":
            tid = p["threadId"]
            mode = p["input"][0]["text"]
            if "[Saved user message]\n" in mode:
                mode = mode.rsplit("[Saved user message]\n", 1)[1].split("\n\n[Saved", 1)[0]
            base = (int(tid.rsplit("-", 1)[1]) - 1) * 10  # first RPC id deliberately 0
            send({"id": mid, "result": {"turn": {"id": "turn-" + tid}}})
            if mode == "unknown":
                call("unknown-thread", 9999, "ui_show", "ORPHAN")
                complete(tid)
            else:
                if mode == "cancel":
                    send({"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": "FIRST"}})
                else:
                    call(tid, base, "bash", "FIRST")
                threading.Thread(target=later, args=(tid, base, mode), daemon=True).start()
        elif method is None and mid is not None:
            with lock:
                tid = pending.pop(mid, None)
                remaining = tid and tid in pending.values()
            if tid and tid != "unknown-thread" and not remaining:
                complete(tid)
        elif mid is not None:
            send({"id": mid, "result": {}})


def run():
    here = Path(__file__).resolve()
    shim = os.environ.get("SHIM_UNDER_TEST", str(here.parent.parent / "scripts/server-v2.js"))
    with tempfile.TemporaryDirectory(prefix="codex-late-tools-") as tmp:
        root = Path(tmp)
        fake = root / "fake-codex"
        shutil.copyfile(here, fake)
        fake.chmod(0o755)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {**os.environ, "CODEX_BIN": str(fake), "SHIM_PORT": str(port),
               "CODEX_WORKDIR": tmp + "/workdir", "SHIM_SESSIONS_DIR": tmp + "/sessions",
               "SHIM_HISTEDIT_DIR": tmp + "/history", "SHIM_FP_DIR": tmp + "/fp",
               "SHIM_SAFE_MODEL_CATALOG": tmp + "/safe-models.json", "SHIM_MODELS": "mock-model",
               "SHIM_NOTICE_FMT": "text", "FAKE_CODEX_CAPTURE": tmp + "/rpc.jsonl"}
        env.pop("SHIM_UI_SOCKET", None)
        log = open(tmp + "/log", "w+")
        proc = subprocess.Popen([shutil.which("bun"), shim], env=env,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        url = f"http://127.0.0.1:{port}"

        def post(key, messages, reply="reply", stream=False, tools=True):
            body = {"model": "mock-model", "prompt_cache_key": key, "messages": messages,
                    "_vellum": {"version": 3, "reply_id": reply, "messages": []}}
            if tools:
                body["tools"] = [{"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}
                                 for name in ("bash", "ui_show", "remember")]
            r = urllib.request.urlopen(urllib.request.Request(url + "/v1/chat/completions",
                json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=8)
            if stream:
                return r
            with r:
                return r.read().decode()

        def calls(wire):
            return [t for line in wire.splitlines() if line.startswith("data: {")
                    for c in json.loads(line[6:]).get("choices", [])
                    for t in c.get("delta", {}).get("tool_calls", [])]

        def rpcs():
            return [json.loads(line) for line in (root / "rpc.jsonl").read_text().splitlines()]

        def state(key):
            return json.loads((root / "sessions" / (hashlib.sha1(key.encode()).hexdigest() + ".json")).read_text())

        def finish(key, history, tools, reply):
            history = history + [{"role": "assistant", "content": None, "tool_calls": tools}]
            history += [{"role": "tool", "tool_call_id": t["id"], "content": "REAL_RESULT_" + t["function"]["name"]}
                        for t in tools]
            return post(key, history, reply), history

        def scenario(key):
            history = [{"role": "user", "content": "late"}]
            first = calls(post(key, history, key + "-r1"))
            assert [t["function"]["name"] for t in first] == ["bash"], first
            tid = "thread-" + str(sum(m.get("method") == "thread/start" for m in rpcs()))
            # Wait for the background native exec to issue both late calls.
            time.sleep(1.4)
            # No fake response, no {} returned, no automatic execution.
            st = state(key) if not key.startswith("router-oneuse-") else None
            if st:
                queued = [p for p in st["parked"].values() if p.get("delivered") is False]
                assert [p["name"] for p in queued] == ["ui_show", "remember"], st
                assert all(p["arguments"]["value"].startswith("LATE") for p in queued), queued
                base = next(p["rpcId"] for p in st["parked"].values() if p["name"] == "bash")
                assert not any(m.get("method") is None and m.get("id") in (base + 1, base + 2) for m in rpcs()), rpcs()
            second_wire, history = finish(key, history, first, key + "-r2")
            second = calls(second_wire)
            assert [t["function"]["name"] for t in second] == ["ui_show", "remember"], second_wire
            assert not set(t["id"] for t in first) & set(t["id"] for t in second)
            wire, history = finish(key, history, second, key + "-r3")
            assert "OK " in wire and not calls(wire), wire
            if st:
                assert state(key)["parked"] == {}, state(key)
                dbpath = root / "sessions" / (hashlib.sha1(key.encode()).hexdigest() + ".ids.sqlite")
                with sqlite3.connect(dbpath) as db:
                    for t in second:
                        rows = db.execute("SELECT vellum_id FROM cli_ids WHERE vellum_id=?", (key + "-r2/" + t["id"],)).fetchall()
                        assert rows, (t, rows)
            print("PASS:", key, "late calls persisted/delivered once; real results; correct reply IDs")

        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(url + "/v1/models", timeout=.2): break
                except Exception: time.sleep(.05)
            else: raise AssertionError("startup failed")
            scenario("late-tools")
            scenario("router-oneuse-late-tools")
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(scenario, ("parallel-a", "parallel-b")))

            # Cancellation before the first tool is emitted. Poll only drains the queue,
            # never replays the user prompt, and retains the original call IDs.
            key = "cancel-tools"
            history = [{"role": "user", "content": "cancel"}]
            r = post(key, history, key + "-r1", stream=True, tools=False)
            while b"FIRST" not in r.readline(): pass
            r.close()
            time.sleep(2.2)
            before = sum(m.get("method") == "turn/start" for m in rpcs())
            # Keep the same fingerprint (no tools); caller can still drain captured fake tools.
            wire = post(key, history, key + "-r2", tools=False)
            queued = calls(wire)
            assert len(queued) == 3, wire
            assert sum(m.get("method") == "turn/start" for m in rpcs()) == before, rpcs()
            history += [{"role": "assistant", "content": None, "tool_calls": queued}]
            history += [{"role": "tool", "tool_call_id": t["id"], "content": "RESULT"} for t in queued]
            assert "OK " in post(key, history, key + "-r3", tools=False)
            print("PASS: cancellation preserves undelivered calls; poll does not replay prompt")

            key = "unavailable-tools"
            history = [{"role": "user", "content": "unavailable"}]
            first = calls(post(key, history))
            time.sleep(1.4)
            st = state(key)
            base = next(p["rpcId"] for p in st["parked"].values() if p["name"] == "bash")
            refused = [m for m in rpcs() if m.get("method") is None and m.get("id") == base + 1]
            assert refused and refused[-1]["result"]["success"] is False, refused
            wire, history = finish(key, history, first, "unavailable-r2")
            late = calls(wire)
            assert [t["function"]["name"] for t in late] == ["remember"], wire
            wire, history = finish(key, history, late, "unavailable-r3")
            assert "OK " in wire, wire
            print("PASS: unavailable device tool fails explicitly even without HTTP handler")

            post("unknown-tools", [{"role": "user", "content": "unknown"}])
            time.sleep(.1)
            refused = [m for m in rpcs() if m.get("method") is None and m.get("id") == 9999]
            assert refused and refused[-1]["result"]["success"] is False, refused
            print("PASS: truly orphaned tool receives a valid failure, never {}")
            assert proc.poll() is None
            log.flush(); log.seek(0)
            assert "answering EMPTY" not in log.read()
        finally:
            if proc.poll() is None: os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
            log.seek(0); logs = log.read(); log.close()
            if sys.exc_info()[0]: print(logs, file=sys.stderr)


if __name__ == "__main__":
    fake_server() if "app-server" in sys.argv else run()
