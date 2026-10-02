// shim-router: cascade proxy for Vellum internal call sites.
// Order: Claude shim (Sonnet, subscription) -> Codex shim (gpt-6-luna, subscription) -> OpenRouter Sonnet (paid).
// Cascade only on: network error, timeout before first byte, 429, 5xx. 4xx (except 429) passes through.
// Mid-stream failures are NOT retried (bytes already delivered); stream just ends.

const PORT = Number(process.env.SHIM_ROUTER_PORT || 8322);
const CONNECT_TIMEOUT_MS = Number(process.env.SHIM_ROUTER_CONNECT_TIMEOUT_MS || 15000);
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.SHIM_ROUTER_FIRST_BYTE_TIMEOUT_MS || 240000);

const UPSTREAMS = [
  {
    name: "claude-shim",
    base: process.env.CLAUDE_SHIM_BASE || "http://127.0.0.1:8320/v1",
    model: process.env.CLAUDE_SHIM_MODEL || "claude-sonnet",
  },
  {
    name: "codex-shim",
    base: process.env.CODEX_SHIM_BASE || "http://127.0.0.1:8321/v1",
    model: process.env.CODEX_SHIM_MODEL || "gpt-6-luna",
  },
  {
    name: "openrouter",
    base: process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1",
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6",
    key: process.env.OPENROUTER_API_KEY || "",
  },
];

const log = (...a) => console.log(new Date().toISOString(), "[router]", ...a);

// Stable one-use key: internal call sites arrive without prompt_cache_key, and both
// shims treat router-oneuse-* as "kill right after the turn, never pool, never persist".
// The key must be STABLE across a task's tool round-trips (same first user message) or
// a follow-up carrying tool results would miss its in-flight process. Hashing the first
// user + system blocks gives exactly that; tool-less tasks (greetings, titles) don't care.
import { createHash } from "crypto";
function oneUseKey(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const pick = (role) => {
    const m = msgs.find((x) => x.role === role);
    return m ? JSON.stringify(m.content) : "";
  };
  return "router-oneuse-" + createHash("sha1").update(pick("system") + "|" + pick("user")).digest("hex").slice(0, 24);
}

function cascadableStatus(status) {
  return status === 429 || status >= 500;
}

async function attemptUpstream(up, body, streamWanted) {
  const payload = { ...body, model: up.model };
  // claude-shim rejects keyless requests; internal call sites may carry no cache key.
  // Give each such call a fresh id so every request is a clean one-shot session.
  if (!payload.prompt_cache_key) payload.prompt_cache_key = oneUseKey(body);
  const headers = { "content-type": "application/json" };
  if (up.key) headers["authorization"] = `Bearer ${up.key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("connect/first-byte timeout")), FIRST_BYTE_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${up.base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, why: `network: ${e.message}` };
  }
  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => "");
    if (cascadableStatus(resp.status)) {
      return { ok: false, why: `http ${resp.status}: ${text.slice(0, 200)}` };
    }
    // 4xx (except 429): pass through to caller as-is
    return {
      ok: true, passthrough: true, status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") || "application/json" },
      bodyText: text,
    };
  }
  if (!streamWanted) {
    clearTimeout(timer);
    const text = await resp.text();
    return { ok: true, status: 200, headers: { "content-type": "application/json" }, bodyText: text };
  }
  // Stream: wait for the first chunk before committing to this upstream.
  const reader = resp.body.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (e) {
    clearTimeout(timer);
    try { reader.cancel(); } catch {}
    return { ok: false, why: `stream error before first chunk: ${e.message}` };
  }
  clearTimeout(timer);
  if (first.done) {
    return { ok: false, why: "stream ended with zero chunks" };
  }
  const outStream = new ReadableStream({
    start(controller) {
      controller.enqueue(first.value);
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (e) {
          log(up.name, "mid-stream failure:", e.message);
          try { controller.error(e); } catch {}
        }
      })();
    },
    cancel() { try { reader.cancel(); } catch {} },
  });
  return { ok: true, status: 200, headers: { "content-type": "text/event-stream" }, stream: outStream };
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{ id: "router-auto", object: "model", created: 0, owned_by: "shim-router" }],
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, upstreams: UPSTREAMS.map((u) => u.name) });
    }
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: { message: "bad json" } }, { status: 400 });
    }
    const streamWanted = body.stream === true;
    const msgs = Array.isArray(body.messages) ? body.messages.length : 0;
    const errors = [];
    for (const up of UPSTREAMS) {
      const t0 = Date.now();
      const res = await attemptUpstream(up, body, streamWanted);
      const dt = Date.now() - t0;
      if (!res.ok) {
        log(`[fail] ${up.name} (${dt}ms): ${res.why}`);
        errors.push(`${up.name}: ${res.why}`);
        continue;
      }
      log(`[ok] ${up.name} (${dt}ms) msgs=${msgs} stream=${streamWanted}${res.passthrough ? " passthrough" : ""}`);
      if (res.passthrough || res.bodyText !== undefined) {
        return new Response(res.bodyText, { status: res.status, headers: res.headers });
      }
      return new Response(res.stream, { status: 200, headers: res.headers });
    }
    log("[fail] all upstreams exhausted");
    return Response.json(
      { error: { message: `shim-router: all upstreams failed — ${errors.join(" | ")}`, type: "server_error" } },
      { status: 502 },
    );
  },
});

log(`shim-router listening on 127.0.0.1:${PORT} cascade=${UPSTREAMS.map((u) => `${u.name}(${u.model})`).join(" -> ")}`);
