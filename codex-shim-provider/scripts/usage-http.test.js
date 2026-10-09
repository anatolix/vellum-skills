import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const chunks = text => text.split("\n").filter(s => s.startsWith("data: ") && s !== "data: [DONE]").map(s => JSON.parse(s.slice(6)));
for (const mode of ["early", "late", "internal"]) test("actual Codex HTTP tool roundtrip: " + mode + " usage, cold call not lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  mkdirSync(join(dir, "home")); mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "home/models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }));
  const bin = join(dir, "fake-cli");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${import.meta.dir}/fixtures/usage-cli.js" "$@"\n`); chmodSync(bin, 0o700);
  const port = 22000 + Math.floor(Math.random() * 10000);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "server-v2.js")], { stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SHIM_PORT: String(port), CODEX_BIN: bin, CODEX_WORKDIR: join(dir, "work"), SHIM_CODEX_HOME: join(dir, "home"),
      SHIM_SAFE_MODEL_CATALOG: join(dir, "safe.json"), SHIM_SESSIONS_DIR: join(dir, "sessions"), SHIM_UI_SOCKET: "", SHIM_TEST_USAGE_MODE: mode } });
  const stdout = new Response(proc.stdout).text(), stderr = new Response(proc.stderr).text();
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/v1/models")).ok) { ready = true; break; } } catch {} await Bun.sleep(30); }
    expect(ready).toBe(true);
    const tools = [{ type: "function", function: { name: "echo", parameters: { type: "object", properties: {} } } }];
    const messages = [{ role: "system", content: "usage test" }, { role: "user", content: "run echo" }];
    const request = async () => {
      const r = await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-6.1-sol", prompt_cache_key: "usage-test", tools, messages }) });
      expect(r.status).toBe(200);
      const cs = chunks(await r.text()); expect(cs.some(c => c.error)).toBe(false); return cs;
    };
    const first = await request();
    const calls = first.flatMap(c => c.choices || []).flatMap(c => c.delta?.tool_calls || []);
    let second = [];
    if (mode === "internal") expect(calls).toHaveLength(0);
    else {
      expect(calls).toHaveLength(1);
      if (mode === "late") { expect(first.some(c => c.usage)).toBe(false); await Bun.sleep(1000); }
      messages.push({ role: "assistant", content: "", tool_calls: calls.map(({ index, ...c }) => c) },
        { role: "tool", tool_call_id: calls[0].id, content: "ok" });
      second = await request();
    }
    const us = [...first, ...second].filter(c => c.usage).map(c => c.usage);
    expect(us.reduce((n, u) => n + u.prompt_tokens, 0)).toBe(96458);
    expect(us.reduce((n, u) => n + u.prompt_tokens_details.cached_tokens, 0)).toBe(47744);
    expect(us.reduce((n, u) => n + u.completion_tokens, 0)).toBe(396);
    expect(us.reduce((n, u) => n + u.completion_tokens_details.reasoning_tokens, 0)).toBe(41);
  } finally { proc.kill(); await proc.exited; await stdout; await stderr; rmSync(dir, { recursive: true, force: true }); }
}, 15000);
