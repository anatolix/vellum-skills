#!/usr/bin/env python3
"""End-to-end shim SSE regressions. Fake app-server only: no network/model quota."""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def fake_server():
    def send(obj):
        print(json.dumps(obj), flush=True)

    def reply(mid, result):
        send({"id": mid, "result": result})

    def notif(method, tid, **params):
        send({"method": method, "params": {"threadId": tid, **params}})

    def usage(tid, reasoning=152, missing=False):
        last = {"inputTokens": 100, "outputTokens": 200, "cachedInputTokens": 70}
        if not missing:
            last["reasoningOutputTokens"] = reasoning
        notif("thread/tokenUsage/updated", tid, turnId="turn-" + tid,
              tokenUsage={"last": last, "total": {**last, "reasoningOutputTokens": 999999}})

    def summary(tid, text="Real summary.", item_id="r1"):
        notif("item/reasoning/summaryTextDelta", tid, itemId=item_id, delta=text)

    def item(tid, text=None, raw=None, item_id="r1"):
        notif("item/completed", tid, item={"type": "reasoning", "id": item_id,
              "summary": [text] if text else [], "content": [raw] if raw else [],
              "encrypted_content": "OPAQUE-NEVER-DISPLAY"})

    def complete(tid, failed=False):
        turn = {"id": "turn-" + tid, "status": "failed" if failed else "completed"}
        if failed:
            turn["error"] = {"message": "fake failure"}
        notif("turn/completed", tid, turn=turn)

    counter = 0
    parked = {}
    for line in sys.stdin:
        m = json.loads(line)
        if os.environ.get("FAKE_CODEX_CAPTURE"):
            with open(os.environ["FAKE_CODEX_CAPTURE"], "a") as captured:
                captured.write(json.dumps(m) + "\n")
        method, mid, p = m.get("method"), m.get("id"), m.get("params", {})
        if method == "initialize":
            reply(mid, {})
        elif method == "model/list":
            reply(mid, {"data": [{"id": "mock-model", "hidden": False,
                                  "supportedReasoningEfforts": [{"reasoningEffort": "high"}]}]})
        elif method == "thread/start":
            counter += 1
            reply(mid, {"thread": {"id": "thread-" + str(counter)}})
        elif method == "thread/resume":
            reply(mid, {"thread": {"id": p["threadId"]}})
        elif method == "turn/start":
            tid = p["threadId"]
            case = p["input"][0]["text"]
            reply(mid, {"turn": {"id": "turn-" + tid, "status": "inProgress"}})
            notif("item/started", tid, item={"type": "reasoning", "id": "r1", "summary": [], "content": []})
            if case == "summary":
                summary(tid)
                item(tid, text="Real summary.")
            elif case == "late-summary":
                usage(tid)
                time.sleep(0.025)
                summary(tid)
            elif case == "raw":
                notif("item/reasoning/textDelta", tid, itemId="r1", delta="Exposed raw text.")
            elif case == "item-summary":
                item(tid, text="Snapshot summary.")
            elif case == "item-raw":
                item(tid, raw="Snapshot raw text.")
            elif case == "multiple-items":
                summary(tid)
                item(tid, text="Real summary.")
                item(tid, text="Second summary.", item_id="r2")
            elif case == "blank-summary":
                notif("item/reasoning/summaryPartAdded", tid, itemId="r1")
                summary(tid, text="  \n")
                item(tid)
            else:
                item(tid)
            if case == "no-usage":
                pass
            elif case == "missing-count":
                usage(tid, missing=True)
            elif case == "zero":
                usage(tid, reasoning=0)
            elif case == "negative":
                usage(tid, reasoning=-1)
            elif case == "string-count":
                usage(tid, reasoning="152")
            elif case == "fraction":
                usage(tid, reasoning=1.5)
            elif case == "updated-count":
                usage(tid, reasoning=100)
                usage(tid, reasoning=152)
            else:
                usage(tid)
                if case == "duplicate":
                    usage(tid)
            if case == "tool":
                parked[0] = tid
                send({"id": 0, "method": "item/tool/call",
                      "params": {"threadId": tid, "turnId": "turn-" + tid, "callId": "c1",
                                 "tool": "bash", "arguments": {"command": "true"}}})
            elif case == "failed":
                complete(tid, failed=True)
            else:
                notif("item/agentMessage/delta", tid, delta="OK")
                complete(tid)
        elif method is None and mid in parked:
            tid = parked.pop(mid)
            summary(tid, text="Tool result summary.", item_id="r2")
            usage(tid, reasoning=25)
            notif("item/agentMessage/delta", tid, delta="Tool OK")
            complete(tid)


def run_tests():
    here = Path(__file__).resolve()
    shim = here.parent.parent / "scripts/server-v2.js"
    with tempfile.TemporaryDirectory(prefix="codex-shim-test-") as tmp:
        fake = Path(tmp) / "fake-codex"
        shutil.copyfile(here, fake)
        fake.chmod(0o755)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {**os.environ, "CODEX_BIN": str(fake), "SHIM_PORT": str(port),
               "CODEX_WORKDIR": tmp + "/workdir", "SHIM_SESSIONS_DIR": tmp + "/sessions",
               "SHIM_MODELS": "mock-model", "FAKE_CODEX_CAPTURE": tmp + "/rpc.jsonl"}
        for name in ("SHIM_ALLOW_KEYLESS", "SHIM_NATIVE_TOOLS", "SHIM_MAX_FEED",
                     "SHIM_DEFAULT_EFFORT", "SHIM_REASONING_SUMMARY"):
            env.pop(name, None)
        logfile = open(tmp + "/shim.log", "w+")
        proc = subprocess.Popen([shutil.which("bun"), str(shim)], env=env,
                                stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
        url = "http://127.0.0.1:" + str(port)

        def request(case, *, key=None, tools=None, messages=None, header=False):
            body = {"model": "mock-model", "messages": messages or [{"role": "user", "content": case}]}
            headers = {"Content-Type": "application/json"}
            if key is None:
                key = "test-" + case
            if header:
                headers["X-Conversation-Id"] = key
            elif key:
                body["prompt_cache_key"] = key
            if tools:
                body["tools"] = tools
            req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), headers)
            with urllib.request.urlopen(req, timeout=8) as response:
                wire = response.read().decode()
            assert wire.endswith("data: [DONE]\n\n"), wire
            chunks = [json.loads(line[6:]) for line in wire.splitlines()
                      if line.startswith("data: ") and line != "data: [DONE]"]
            return chunks

        def thinking(chunks):
            return "".join(c["delta"].get("reasoning_content", "")
                           for chunk in chunks for c in chunk.get("choices", []))

        def last_usage(chunks):
            return next((c["usage"] for c in reversed(chunks) if "usage" in c), {})

        def assert_fallback(chunks, count=152):
            text = thinking(chunks)
            assert text.count("[codex-shim]") == 1, text
            assert "Reasoning: " + str(count) + " токенов" in text, text
            assert "OPAQUE" not in text and "999999" not in text, text
            u = last_usage(chunks)
            assert u["completion_tokens_details"]["reasoning_tokens"] == count, u
            assert u["total_tokens"] == 300 and u["completion_tokens"] == 200, u
            fallback_index = next(i for i, c in enumerate(chunks)
                                  if any("[codex-shim]" in x["delta"].get("reasoning_content", "")
                                         for x in c.get("choices", [])))
            finish_index = next(i for i, c in enumerate(chunks)
                                if any(x.get("finish_reason") for x in c.get("choices", [])))
            assert fallback_index < finish_index, chunks

        try:
            for _ in range(100):
                if proc.poll() is not None:
                    raise RuntimeError("Shim exited during startup")
                try:
                    urllib.request.urlopen(url + "/v1/models", timeout=0.1).close()
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.03)
            else:
                raise RuntimeError("Shim did not start")
            time.sleep(0.05)  # fake app-server initialize/model-list, no inference

            passed = 0
            def check(name, fn):
                nonlocal passed
                fn()
                passed += 1
                print("PASS", name, flush=True)

            for case in ("encrypted", "blank-summary", "duplicate", "updated-count", "failed"):
                check(case, lambda case=case: assert_fallback(request(case)))

            for case, expected in (("summary", "Real summary."), ("late-summary", "Real summary."),
                                   ("raw", "Exposed raw text."), ("item-summary", "Snapshot summary."),
                                   ("item-raw", "Snapshot raw text.")):
                def real(case=case, expected=expected):
                    chunks = request(case)
                    assert thinking(chunks) == expected, thinking(chunks)
                    assert last_usage(chunks)["completion_tokens_details"]["reasoning_tokens"] == 152
                check(case, real)

            def multiple():
                text = thinking(request("multiple-items"))
                assert text == "Real summary.Second summary.", text
            check("multiple-items-no-duplicates", multiple)

            for case in ("no-usage", "missing-count", "zero", "negative", "string-count", "fraction"):
                def no_count(case=case):
                    chunks = request(case)
                    assert not thinking(chunks).strip(), thinking(chunks)
                    details = last_usage(chunks).get("completion_tokens_details")
                    assert details == ({"reasoning_tokens": 0} if case == "zero" else None), details
                check(case + "-no-invented-counter", no_count)

            tool_defs = [{"type": "function", "function": {"name": "bash", "parameters": {"type": "object"}}}]
            def tool_round():
                first = request("tool", tools=tool_defs)
                assert_fallback(first)
                calls = [x["delta"]["tool_calls"][0] for c in first for x in c.get("choices", [])
                         if "tool_calls" in x["delta"]]
                assert len(calls) == 1 and calls[0]["function"]["name"] == "bash", calls
                second = request("tool", tools=tool_defs, messages=[
                    {"role": "user", "content": "tool"},
                    {"role": "tool", "tool_call_id": calls[0]["id"], "content": "Done"}])
                assert thinking(second) == "Tool result summary.", thinking(second)
                assert last_usage(second)["completion_tokens_details"]["reasoning_tokens"] == 25
            check("tool-pause-and-resume-reset", tool_round)

            def buffered():
                chunks = request("buffered", tools=tool_defs)
                assert_fallback(chunks)
                indexes = [(i, x["delta"]) for i, c in enumerate(chunks) for x in c.get("choices", [])]
                ri = next(i for i, d in indexes if "[codex-shim]" in d.get("reasoning_content", ""))
                ci = next(i for i, d in indexes if d.get("content") == "OK")
                assert ri < ci
            check("fallback-before-buffered-answer", buffered)

            check("conversation-header-key", lambda: assert_fallback(request("header", header=True)))

            def keyless():
                try:
                    request("keyless", key="")
                    raise AssertionError("Expected HTTP 400")
                except urllib.error.HTTPError as error:
                    assert error.code == 400
                    assert json.loads(error.read())["error"]["code"] == "missing_session_key"
            check("keyless-still-400", keyless)

            def isolation():
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    a = pool.submit(request, "encrypted", key="parallel-a")
                    b = pool.submit(request, "summary", key="parallel-b")
                    assert_fallback(a.result())
                    assert thinking(b.result()) == "Real summary."
            check("parallel-chat-isolation", isolation)
            def content(chunks):
                return "".join(c["delta"].get("content", "")
                               for chunk in chunks for c in chunk.get("choices", []))

            def captured():
                return [json.loads(line) for line in Path(tmp + "/rpc.jsonl").read_text().splitlines()]

            def log_text():
                return Path(tmp + "/shim.log").read_text()

            def new_thread():
                text = content(request("new-thread", key="guard-new"))
                assert "новый тред ChatGPT" in text and "скармливаю 1 блоков" in text, text
            check("new-thread-notice", new_thread)

            def threshold():
                eight = [{"role": "user", "content": "threshold-" + str(i)} for i in range(8)]
                text = content(request("eight", key="guard-eight", messages=eight))
                assert "REPLAY-SUSPECT" not in text, text
                text = content(request("nine", key="guard-nine", messages=eight + [
                    {"role": "user", "content": "threshold-8"}]))
                assert "REPLAY-SUSPECT: 9 unseen" in text and "лимит 8" in text, text
            check("replay-threshold-strictly-more-than-eight", threshold)

            def unseen_only():
                history = [{"role": "user", "content": "history-" + str(i)} for i in range(8)]
                request("history", key="guard-history", messages=history)
                before = len(log_text())
                text = content(request("followup", key="guard-history", messages=history + [
                    {"role": "user", "content": "only-one-new"}]))
                assert "REPLAY-SUSPECT" not in text and "новый тред" not in text, text
                assert "REPLAY-SUSPECT" not in log_text()[before:]
            check("seen-history-does-not-trigger-warning", unseen_only)

            def retry_only():
                history = [{"role": "user", "content": "threshold-" + str(i)} for i in range(9)]
                before = len(log_text())
                text = content(request("retry-nine", key="guard-nine", messages=history))
                assert "REPLAY-SUSPECT" not in text and "новый тред" not in text, text
                lines = log_text()[before:]
                assert "retry: nothing unseen" in lines and "REPLAY-SUSPECT" not in lines, lines
            check("retry-tail-does-not-retrigger-replay-warning", retry_only)

            def assistant_skipped():
                messages = [{"role": "assistant", "content": "already generated " + str(i)} for i in range(20)]
                messages.append({"role": "user", "content": "one unseen block"})
                text = content(request("assistant-skip", messages=messages))
                assert "скармливаю 1 блоков" in text and "REPLAY-SUSPECT" not in text, text
            check("assistant-history-is-not-fed", assistant_skipped)

            def invalidation():
                request("before-change", key="guard-change")
                before = len(log_text())
                text = content(request("after-change", key="guard-change", messages=[
                    {"role": "system", "content": "changed system"},
                    {"role": "user", "content": "after-change"}]))
                assert "сессия инвалидирована" in text and "fingerprint" in text, text
                assert "DIFF prev:" in log_text()[before:]
            check("invalidation-notice-and-prior-state-diff", invalidation)

            def native_disabled():
                starts = [m["params"] for m in captured() if m.get("method") == "thread/start"]
                assert starts
                for params in starts:
                    assert params["config"]["features"] == {
                        "shell_tool": False, "unified_exec": False, "multi_agent": False}, params
                turns = [m["params"] for m in captured() if m.get("method") == "turn/start"]
                assert all(x["summary"] == "detailed" and x["effort"] == "high" for x in turns), turns
            check("native-tools-off-and-per-turn-summary-effort", native_disabled)

            def live_thread_not_resumed():
                before = len(captured())
                request("live-one", key="guard-live")
                request("live-two", key="guard-live")
                calls = captured()[before:]
                assert sum(m.get("method") == "thread/start" for m in calls) == 1, calls
                assert not any(m.get("method") == "thread/resume" for m in calls), calls
            check("live-thread-does-not-resume-from-disk", live_thread_not_resumed)

            def keyless_no_inference():
                before = len(captured())
                keyless()
                calls = captured()[before:]
                assert not any(m.get("method") in ("thread/start", "turn/start") for m in calls), calls
            check("keyless-400-is-before-inference", keyless_no_inference)

            request("disk-one", key="guard-disk")
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
            proc = subprocess.Popen([shutil.which("bun"), str(shim)], env=env,
                                    stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(100):
                try:
                    urllib.request.urlopen(url + "/v1/models", timeout=0.1).close()
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.03)
            else:
                raise RuntimeError("Shim did not restart")
            time.sleep(0.05)

            def disk_resume():
                before = len(captured())
                text = content(request("disk-two", key="guard-disk"))
                assert "поднят с диска" in text and "новых 1" in text, text
                calls = captured()[before:]
                assert sum(m.get("method") == "thread/resume" for m in calls) == 1, calls
                assert not any(m.get("method") == "thread/start" for m in calls), calls
            check("disk-resume-notice-and-no-fresh-thread", disk_resume)
            print(str(passed) + " tests passed; 0 real model calls.", flush=True)
        except Exception:
            logfile.flush()
            logfile.seek(0)
            print(logfile.read(), file=sys.stderr)
            raise
        finally:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
            logfile.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "app-server":
        fake_server()
    else:
        run_tests()
