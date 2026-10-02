import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";

const base = "/tmp/shim-router-it-" + process.pid;
await rm(base, { recursive: true, force: true });

let claudeHits = 0, codexHits = 0;
const claude = Bun.serve({ port: 18401, fetch() {
  claudeHits++;
  return Response.json({ error: { message: "You've hit your session limit · resets 4:00am UTC" } }, { status: 429, headers: { "retry-after": "600" } });
}});
const codex = Bun.serve({ port: 18402, async fetch(req) {
  codexHits++;
  const body = await req.json();
  const classifier = JSON.stringify(body.messages || []).includes("Classify an LLM provider failure");
  const text = classifier
    ? JSON.stringify({ action: "disable", disable_until: new Date(Date.now() + 600000).toISOString(), reason: "лимит до reset", confidence: 0.99 })
    : "OK";
  const raw = [
    "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]", "",
  ].join("\n\n");
  return new Response(raw, { headers: { "content-type": "text/event-stream" } });
}});
const openrouter = Bun.serve({ port: 18403, fetch() { return new Response("unused", { status: 500 }); } });

const proc = Bun.spawn(["bun", "run", new URL("../scripts/server.js", import.meta.url).pathname], {
  env: {
    ...process.env,
    SHIM_ROUTER_PORT: "18400",
    CLAUDE_SHIM_BASE: "http://127.0.0.1:18401/v1",
    CODEX_SHIM_BASE: "http://127.0.0.1:18402/v1",
    OPENROUTER_BASE: "http://127.0.0.1:18403/v1",
    OPENROUTER_API_KEY: "test",
    SHIM_ROUTER_STATE_PATH: base + "/state.json",
    SHIM_ROUTER_ERROR_LOG_PATH: base + "/errors.jsonl",
    SHIM_ROUTER_DECISION_LOG_PATH: base + "/decisions.jsonl",
    SHIM_ROUTER_TELEGRAM_DRY_RUN: "1",
  },
  stdout: "pipe", stderr: "pipe",
});
try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch("http://127.0.0.1:18400/health"); if (r.ok) break; } catch {}
    await Bun.sleep(50);
  }
  const call = async () => {
    const r = await fetch("http://127.0.0.1:18400/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "router-auto", stream: true, messages: [{ role: "user", content: "reply OK" }] }),
    });
    return await r.text();
  };
  const first = await call();
  assert.match(first, /"content":"OK"/);
  for (let i = 0; i < 100; i++) {
    try {
      const h = await (await fetch("http://127.0.0.1:18400/health")).json();
      if (h.upstreams.find((x) => x.name === "claude-shim").enabled === false) break;
    } catch {}
    await Bun.sleep(50);
  }
  const h = await (await fetch("http://127.0.0.1:18400/health")).json();
  assert.equal(h.upstreams.find((x) => x.name === "claude-shim").enabled, false);
  const firstHits = claudeHits;
  const second = await call();
  assert.match(second, /"content":"OK"/);
  assert.equal(claudeHits, firstHits);
  assert.ok(codexHits >= 3);
  console.log("shim-router integration test: OK");
} finally {
  proc.kill();
  claude.stop(true); codex.stop(true); openrouter.stop(true);
}
