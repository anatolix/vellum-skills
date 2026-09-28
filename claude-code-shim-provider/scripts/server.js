// OpenAI-compatible chat completions shim backed by Claude Code (Agent SDK + OAuth token).
// Listens on 127.0.0.1:8317. Endpoints: POST /v1/chat/completions (SSE), GET /v1/models.
//
// Tool calling: OpenAI `tools` are rendered into the prompt as a text contract.
// The model emits `TOOL_CALL: {"name": ..., "arguments": {...}}` lines; we parse them
// and return real OpenAI `tool_calls` deltas. Tool execution stays on the Vellum side.
// Claude Code's own SDK tools (Bash/Read/...) remain disabled on purpose.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PORT = Number(process.env.SHIM_PORT || 8317);

const MAX_LIVE = Number(process.env.SHIM_MAX_LIVE || process.env.SHIM_POOL_SIZE || 8);
const IDLE_TTL_MS = Number(process.env.SHIM_IDLE_TTL_SEC || 3600) * 1000;
const SESS_DIR = process.env.SHIM_SESSIONS_DIR || `${import.meta.dir}/sessions`;
// One-shot requests (first message of a conversation: no assistant/tool turns yet) get a
// throwaway process that is closed right after the answer. They do not occupy chat slots;
// SHIM_MAX_ONESHOT is a separate OOM guard (~220 MB per process). 0 = unlimited.
const MAX_ONESHOT = Number(process.env.SHIM_MAX_ONESHOT ?? 32);
const DEFAULT_MODEL = "sonnet";
mkdirSync(SESS_DIR, { recursive: true });
const sha = (s) => createHash("sha1").update(s).digest("hex");
const short = (k) => (k ? k.slice(0, 12) : "-");

// ---------------------------------------------------------------------------
// One `claude` process per chat. A Chat is keyed by prompt_cache_key (Vellum's
// conversation id). The process stays alive while the chat is active; after
// IDLE_TTL of silence it is parked: state (session id + hashes of the history
// already fed) is saved to SESS_DIR and the process is closed. The next request
// for that key spawns a new process with `resume: sessionId` and feeds only the
// tail. MAX_LIVE caps live processes; the LRU idle chat is parked to make room.
// Keyless requests get a throwaway process.
// ---------------------------------------------------------------------------
let cliSeq = 0;
class Cli {
  constructor(label, model, resume = null, systemPrompt = null, effort = null) {
    this.id = ++cliSeq;
    this.label = label;
    this.model = model;
    this.sessionId = resume;
    this.alive = true;
    this.inbox = [];
    this.wake = null;
    this.onMsg = null;
    this.done = null;
    this.q = query({
      prompt: this.input(),
      options: {
        model,
        ...(resume ? { resume } : {}),
        // Vellum's system prompt replaces Claude Code's own (tools are off anyway).
        // snapshot:false so a changed prompt takes effect on respawn/resume.
        ...(systemPrompt ? { systemPrompt: { type: "custom", prompt: systemPrompt, snapshot: false } } : {}),
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
        tools: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
        includePartialMessages: true,
        // Thinking: adaptive by default; display:"summarized" is REQUIRED — without it
        // subscription traffic gets redacted blocks (empty text + signature, only
        // estimated_tokens). Summaries stream as thinking_delta → reasoning_content.
        // reasoning_effort "none" disables thinking; xhigh/max clamp to high.
        ...(effort === "none"
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "adaptive", display: "summarized" },
              ...(effort ? { effort: ["low", "medium", "high"].includes(effort) ? effort : "high" } : {}) }),
      },
    });
    this.pump().catch(() => {});
  }

  async *input() {
    while (this.alive) {
      if (!this.inbox.length) await new Promise((r) => (this.wake = r));
      while (this.inbox.length) {
        const content = this.inbox.shift();
        yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.sessionId || "" };
      }
    }
  }

  async pump() {
    try {
      for await (const msg of this.q) {
        if (msg.type === "system" && msg.subtype === "init") this.sessionId = msg.session_id;
        if (msg.type === "result" && msg.session_id) this.sessionId = msg.session_id;
        if (this.onMsg) this.onMsg(msg);
        if (msg.type === "result" && this.done) {
          const d = this.done; this.done = null; this.onMsg = null;
          d.resolve(msg);
        }
      }
      throw new Error("query stream ended");
    } catch (e) {
      this.die(e);
    }
  }

  die(err) {
    if (!this.alive) return;
    this.alive = false;
    if (err) console.log(`[cli${this.id} ${this.label}] dead: ${String(err?.message || err).slice(0, 200)}`);
    if (this.done) { const d = this.done; this.done = null; this.onMsg = null; d.reject(err || new Error("closed")); }
    this.wake?.(); this.wake = null;
    try { this.q?.close?.(); } catch {}
    manager.kick();
  }

  close() { this.die(null); }

  send(content, onMsg) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("cli closed"));
      this.done = { resolve, reject };
      this.onMsg = onMsg;
      this.inbox.push(content);
      this.wake?.(); this.wake = null;
    });
  }

  async setModel(m) {
    if (m !== this.model) { await this.q.setModel(m); this.model = m; }
  }
}

class Chat {
  constructor(key, saved = null) {
    this.key = key;
    this.sessionId = saved?.sessionId ?? null;
    this.sent = saved?.sent ?? [];        // sha1 of every input block already fed to the session
    this.model = saved?.model ?? DEFAULT_MODEL;
    this.lastUsed = saved?.lastUsed ?? Date.now();
    this.served = saved?.served ?? 0;
    this.sysHash = saved?.sysHash ?? null;
    this.effort = saved?.effort ?? null;
    this.cli = null;
    this.busy = false;
    this.lock = Promise.resolve();
  }
  get live() { return !!this.cli?.alive; }
  file() { return `${SESS_DIR}/${sha(this.key)}.json`; }
  save() {
    try {
      writeFileSync(this.file(), JSON.stringify({ key: this.key, sessionId: this.sessionId, model: this.model, sent: this.sent, sysHash: this.sysHash, effort: this.effort, lastUsed: this.lastUsed, served: this.served, savedAt: Date.now() }));
    } catch (e) { console.error(`[sess] save failed ${short(this.key)}: ${e.message}`); }
  }
  park(reason) {
    if (this.cli) {
      console.log(`[sess] ${short(this.key)} park (${reason}) cli${this.cli.id} session=${this.sessionId}`);
      this.cli.close(); this.cli = null;
    }
    this.save();
  }

  // Requests for one chat are serialised; Vellum sends full history each time.
  async run(model, blocks, onMsg, effort = null) {
    const prev = this.lock;
    let release; this.lock = new Promise((r) => (release = r));
    await prev;
    this.busy = true;
    try { return await this._run(model, blocks, onMsg, effort); }
    finally { this.busy = false; this.lastUsed = Date.now(); release(); manager.kick(); }
  }

  // No resets. The CLI transcript is the source of truth; Vellum's history is
  // only used to find what the CLI has not seen yet. Every input block whose
  // hash is unknown to this chat is fed, in order. Compaction (summary replaces
  // the head) therefore sends just the summary; a retried identical history
  // re-sends the last user block. A fresh process is spawned only when there is
  // no live one, with `resume` when a session id exists.
  async _run(model, blocks, onMsg, effort = null) {
    const inputs = inputBlocks(blocks);
    const hashes = inputs.map((b) => sha(b.text));
    const sys = systemText(blocks);
    const sysHash = sys ? sha(sys) : null;
    if (this.live && sysHash !== this.sysHash) this.park("system changed");
    if (this.live && (effort ?? null) !== (this.effort ?? null)) this.park("effort changed");
    const seen = new Set(this.sent);
    let unseen = inputs.filter((_, i) => !seen.has(hashes[i]));
    let why = !this.sent.length ? "new" : unseen.length ? `tail=${unseen.length}` : "repeat";
    if (!unseen.length) unseen = inputs.slice(-1);
    for (let attempt = 0; attempt < 2; attempt++) {
      let produced = false;
      const t0 = Date.now();
      try {
        if (!this.live) {
          this.cli = await manager.spawn(short(this.key), model, this.sessionId, sys, effort);
          why += this.sessionId ? " resume" : " spawn";
          this.sysHash = sysHash;
        }
        await this.cli.setModel(model);
        const prompt = unseen.map((b) => b.text).concat(["Assistant:"]).join("\n\n");
        console.log(`[sess] ${short(this.key)} cli${this.cli.id} ${why} blocks=${inputs.length} seen=${this.sent.length}`);
        const tPrep = Date.now() - t0;
        const res = await this.cli.send(prompt, (m) => { produced = true; onMsg(m); });
        for (const h of hashes) seen.add(h);
        this.sent = [...seen]; this.sessionId = res.session_id || this.cli.sessionId; this.model = model; this.effort = effort ?? null; this.served++; this.lastUsed = Date.now();
        this.save();
        if (res.subtype && res.subtype !== "success") console.log(`[sess] ${short(this.key)} result subtype=${res.subtype} ${String(res.result || "").slice(0, 120)}`);
        console.log(`[sess] ${short(this.key)} served #${this.served} model=${model} prep=${tPrep}ms total=${Date.now() - t0}ms in=${res.usage?.input_tokens ?? "?"} cache_read=${res.usage?.cache_read_input_tokens ?? "?"} session=${this.sessionId}`);
        return res;
      } catch (e) {
        this.cli?.die(e); this.cli = null;
        if (produced || attempt) throw e;
        // Resume failed (session file gone, CLI upgrade, ...): start over with the full history.
        console.log(`[sess] ${short(this.key)} resume failed, starting fresh: ${String(e?.message || e).slice(0, 120)}`);
        this.sessionId = null; this.sent = []; seen.clear(); unseen = inputs; why = "fresh";
      }
    }
  }
}

const manager = {
  chats: new Map(),
  ephemeral: new Set(),
  reserved: 0,
  waiters: [],
  liveCount() {
    let n = this.reserved;
    for (const c of this.chats.values()) if (c.live) n++;
    return n;
  },
  get(key) {
    let c = this.chats.get(key);
    if (!c) {
      let saved = null;
      const f = `${SESS_DIR}/${sha(key)}.json`;
      if (existsSync(f)) { try { saved = JSON.parse(readFileSync(f, "utf8")); } catch {} }
      c = new Chat(key, saved);
      if (saved) console.log(`[sess] ${short(key)} loaded from disk session=${saved.sessionId} sent=${saved.sent?.length ?? 0}`);
      this.chats.set(key, c);
    }
    return c;
  },
  // Wait for a free slot (parking the LRU idle chat if needed), then spawn.
  async spawn(label, model, resume, systemPrompt = null, effort = null) {
    while (this.liveCount() >= MAX_LIVE) {
      const idle = [...this.chats.values()].filter((c) => c.live && !c.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length) { idle[0].park("evict"); continue; }
      await new Promise((r) => this.waiters.push(r));
    }
    this.reserved++;
    try { return new Cli(label, model, resume, systemPrompt, effort); } finally { this.reserved--; }
  },
  kick() { const w = this.waiters.splice(0); for (const r of w) r(); },
  reap() {
    const now = Date.now();
    for (const c of this.chats.values()) {
      if (c.live && !c.busy && now - c.lastUsed > IDLE_TTL_MS) c.park("idle");
      else if (!c.live && !c.busy && now - c.lastUsed > 24 * 3600e3) this.chats.delete(c.key); // disk copy stays
    }
  },
  oneshotWaiters: [],
  async runEphemeral(model, blocks, onMsg, tag = "nokey", attempts = 3, effort = null) {
    while (MAX_ONESHOT > 0 && this.ephemeral.size >= MAX_ONESHOT) await new Promise((r) => this.oneshotWaiters.push(r));
    let lastErr;
    for (let a = 0; a < attempts; a++) {
      const cli = new Cli(tag, model, null, systemText(blocks), effort);
      this.ephemeral.add(cli);
      let produced = false;
      try {
        const t0 = Date.now();
        const res = await cli.send(blocksToPrompt(inputBlocks(blocks)), (m) => { produced = true; onMsg(m); });
        console.log(`[${tag}] cli${cli.id} model=${model} total=${Date.now() - t0}ms in=${res.usage?.input_tokens ?? "?"} cache_read=${res.usage?.cache_read_input_tokens ?? "?"}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (produced) throw e;
        console.log(`[${tag}] retry ${a + 1}/${attempts} after: ${String(e?.message || e).slice(0, 120)}`);
      } finally {
        this.ephemeral.delete(cli); cli.close();
        const w = this.oneshotWaiters.shift(); if (w) w();
      }
    }
    throw lastErr;
  },
  // A request whose history has no assistant or tool turns is the first (and, for
  // `assistant inference send` and subagent scripts, the only) message of a conversation.
  // Serve it with a throwaway process; a real chat's second request finds no Chat for the
  // key and spawns one with the full two-block history — one wasted cache write, no slot leak.
  isOneShot(blocks) {
    return !blocks.some((b) => b.role === "assistant" || b.role === "tool");
  },
  run(model, key, blocks, onMsg, effort = null) {
    if (!key) return this.runEphemeral(model, blocks, onMsg, "nokey", 3, effort);
    if (!this.chats.has(key) && this.isOneShot(blocks)) return this.runEphemeral(model, blocks, onMsg, `oneshot ${short(key)}`, 3, effort);
    return this.get(key).run(model, blocks, onMsg, effort);
  },
  status() {
    return {
      maxLive: MAX_LIVE, maxOneshot: MAX_ONESHOT, idleTtlSec: IDLE_TTL_MS / 1000, live: this.liveCount(), oneshot: [...this.ephemeral].map((c) => ({ cli: c.id, label: c.label, model: c.model })), waiters: this.waiters.length, oneshotWaiters: this.oneshotWaiters.length,
      chats: [...this.chats.values()].map((c) => ({ key: short(c.key), live: c.live, busy: c.busy, cli: c.cli?.id ?? null, model: c.model, served: c.served, sent: c.sent.length, session: c.sessionId, idleSec: Math.round((Date.now() - c.lastUsed) / 1000) })),
    };
  },
};
setInterval(() => manager.reap(), 60_000);
process.on("SIGTERM", () => { for (const c of manager.chats.values()) c.park("shutdown"); process.exit(0); });

const TOOL_INSTRUCTIONS = `You have access to the functions listed in <tools>. To call one or more of them,
output ONLY lines of the exact form (one per call, nothing else in the message):
TOOL_CALL: {"name": "<function name>", "arguments": {<json arguments>}}
Rules:
- Each TOOL_CALL must be a single line of valid JSON after the prefix.
- Do not wrap TOOL_CALL lines in markdown fences and do not add commentary around them.
- Call functions only when they are needed; otherwise answer normally in plain text.
- Never use <function_calls>/<invoke> XML or any other native tool-call format. Only TOOL_CALL lines.
- After your TOOL_CALL line(s), STOP. Do not write anything after them.
- Results of your calls arrive in <tool_result> blocks in the NEXT message, from the system.
  NEVER write <tool_result> blocks yourself and never guess what a call would return.`;

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "image_url") return "[image omitted]";
        return "";
      })
      .join("\n");
  }
  return String(content);
}

function tcToJson(tc) {
  const fn = tc.function || {};
  let args = fn.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* keep raw string */ }
  }
  return JSON.stringify({ name: fn.name, arguments: args ?? {} });
}

// Render OpenAI messages into an ordered list of text blocks. Kept per-message
// (not pre-joined) so the session layer can diff history against what a warm
// worker has already seen and send only the tail.
function messagesToBlocks(messages, tools) {
  const blocks = [];
  if (Array.isArray(tools) && tools.length) {
    const defs = tools
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      }));
    blocks.push({ role: "tools", text: `<tools>\n${JSON.stringify(defs, null, 1)}\n</tools>\n\n${TOOL_INSTRUCTIONS}` });
  }
  for (const m of messages) {
    const role = m.role;
    const text = contentToText(m.content);
    if (role === "system") {
      blocks.push({ role, text });
    } else if (role === "user") {
      blocks.push({ role, text: `Human: ${text}` });
    } else if (role === "assistant") {
      const lines = [];
      if (text) lines.push(text);
      for (const tc of m.tool_calls || []) lines.push(`TOOL_CALL: ${tcToJson(tc)}`);
      blocks.push({ role, text: `Assistant: ${lines.join("\n")}` });
    } else if (role === "tool") {
      const label = m.name || m.tool_call_id || "tool";
      blocks.push({ role, text: `<tool_result name="${label}">\n${text}\n</tool_result>` });
    } else {
      blocks.push({ role, text: `${role}: ${text}` });
    }
  }
  return blocks;
}

function blocksToPrompt(blocks) {
  return blocks.map((b) => b.text).concat(["Assistant:"]).join("\n\n");
}

// System prompt handed to the CLI via options.systemPrompt: Vellum's system
// messages followed by the tool contract. Stable across turns, so it is not
// part of the fed history.
function systemText(blocks) {
  const parts = blocks.filter((b) => b.role === "system").map((b) => b.text);
  const tools = blocks.filter((b) => b.role === "tools").map((b) => b.text);
  return parts.concat(tools).join("\n\n") || null;
}

// History fed to the CLI as user input. System/tools go via options; assistant
// turns are skipped: the CLI already holds its own replies in the transcript.
function inputBlocks(blocks) {
  return blocks.filter((b) => b.role !== "assistant" && b.role !== "system" && b.role !== "tools");
}

// Extract TOOL_CALL lines; return { calls, restText }.
// Guards against fabrication: a <tool_result written by the model OUTSIDE a
// TOOL_CALL line truncates the output there (imagined continuation), and
// everything after the first parsed TOOL_CALL is discarded. A TOOL_CALL whose
// JSON merely *mentions* "<tool_result" is fine — line-level check, not global.
const TOOL_CALL_RE = /TOOL_CALL:\s*(\{.*\})\s*$/;
// Fallback: model slipped into Anthropic-native <invoke> XML instead of the contract.
// Take ONLY the first invoke — later ones were written blind, before any result.
const INVOKE_RE = /<(?:[\w-]+:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:[\w-]+:)?invoke>/;
const PARAM_RE = /<(?:[\w-]+:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:[\w-]+:)?parameter>/g;
function parseInvoke(text, tools) {
  if (/TOOL_CALL:/.test(text)) return null;
  const m = text.match(INVOKE_RE);
  if (!m) return null;
  const def = (tools || []).find((t) => (t.function?.name ?? t.name) === m[1]);
  const props = def?.function?.parameters?.properties || {};
  const args = {};
  for (const p of m[2].matchAll(PARAM_RE)) {
    let v = p[2].replace(/^\n/, "").replace(/\n$/, "");
    const type = props[p[1]]?.type;
    if (type && type !== "string") { try { v = JSON.parse(v.trim()); } catch {} }
    args[p[1]] = v;
  }
  const total = (text.match(new RegExp(INVOKE_RE.source, "g")) || []).length;
  let before = text.slice(0, m.index).replace(/<\/?(?:[\w-]+:)?function_calls>/g, "");
  const fab = before.search(/<tool_result\b/);
  if (fab >= 0) before = before.slice(0, fab);
  console.log(`[warn] model used <invoke> XML instead of TOOL_CALL; took 1 of ${total}`);
  return { calls: [{ name: m[1], arguments: args }], restText: before.trim() };
}

function parseToolCalls(text, tools = []) {
  const inv = parseInvoke(text, tools);
  if (inv) return inv;
  const calls = [];
  const rest = [];
  let sawCall = false;
  let fabricated = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^`+|`+$/g, "");
    const m = line.match(TOOL_CALL_RE); // not anchored at start: tolerates junk before prefix
    if (m) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj && typeof obj.name === "string") {
          calls.push({ name: obj.name, arguments: obj.arguments ?? {} });
          sawCall = true;
          continue;
        }
      } catch (e) {
        console.log("[warn] unparsable TOOL_CALL line:", String(e.message).slice(0, 80), "|", line.slice(0, 160));
      }
    }
    if (/<tool_result\b/.test(line)) {
      fabricated = true;
      console.log("[warn] model fabricated <tool_result>; output truncated");
      break;
    }
    if (sawCall) continue; // everything after the first call is discarded
    if (line === "```") continue;
    rest.push(raw);
  }
  let restText = rest.join("\n").trim();
  if (fabricated && !calls.length && !restText) {
    restText = "[shim] Ответ модели отброшен: она написала <tool_result> сама вместо вызова инструмента. Повтори запрос.";
  }
  return { calls, restText };
}


// Map Claude CLI result.usage -> OpenAI usage chunk. Vellum's openai-compatible
// provider treats prompt_tokens as the TOTAL (cached is a subset), so sum all
// three input buckets and expose cache read/write under prompt_tokens_details.
function usageFromResult(res) {
  const u = res?.usage;
  if (!u) return null;
  const input = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  return {
    prompt_tokens: input + read + write,
    completion_tokens: out,
    total_tokens: input + read + write + out,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
  };
}

function sseChunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

Bun.serve({
  port: PORT,
  idleTimeout: 255, // Bun default 10s kills slow Claude Code spawns
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [
          { id: "claude-opus", object: "model", created: 0, owned_by: "claude-code" },
          { id: "claude-sonnet", object: "model", created: 0, owned_by: "claude-code" },
        ],
      });
    }

    if (url.pathname === "/pool" || url.pathname === "/chats") return Response.json(manager.status());

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    let body;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

    const model = body.model || "claude-opus";
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasTools = tools.length > 0;
    const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort
      : typeof body.reasoning?.effort === "string" ? body.reasoning.effort : null;
    console.log(`[req] model=${model} msgs=${(body.messages || []).length} tools=${tools.length} effort=${effort ?? "-"} key=${typeof body.prompt_cache_key === "string" ? body.prompt_cache_key.slice(0, 12) : "-"}`);
    const sdkModel = model.replace(/^claude-/, ""); // opus | sonnet | haiku
    const blocks = messagesToBlocks(body.messages || [], tools);
    const cacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? body.prompt_cache_key : null;
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (s) => controller.enqueue(enc.encode(s));
        try {
          send(sseChunk(id, model, { role: "assistant" }));
          let buffer = "";
          let sawDelta = false;
          const result = await manager.run(sdkModel, cacheKey, blocks, (msg) => {
            if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "thinking_delta") {
              const thinking = msg.event.delta?.thinking;
              if (thinking) send(sseChunk(id, model, { reasoning_content: thinking })); // Vellum renders as thinking
              return;
            }
            if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
              const text = msg.event.delta?.text;
              if (!text) return;
              sawDelta = true;
              if (hasTools) buffer += text;               // must buffer to detect TOOL_CALL
              else send(sseChunk(id, model, { content: text }));
            } else if (msg.type === "assistant" && !sawDelta) {
              const text = (msg.message?.content || [])
                .filter((b) => b.type === "text").map((b) => b.text).join("");
              if (!text) return;
              if (hasTools) buffer += text;
              else send(sseChunk(id, model, { content: text }));
            }
          }, effort);

          if (hasTools) {
            const { calls, restText } = parseToolCalls(buffer, tools);
            if (calls.length) {
              if (restText) send(sseChunk(id, model, { content: restText }));
              const tool_calls = calls.map((c, i) => ({
                index: i,
                id: "call_" + Math.random().toString(36).slice(2, 12),
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              }));
              send(sseChunk(id, model, { tool_calls }));
              send(sseChunk(id, model, {}, "tool_calls"));
              console.log(`[res] tool_calls=${calls.map((c) => c.name).join(",")}`);
            } else {
              if (buffer) send(sseChunk(id, model, { content: buffer }));
              send(sseChunk(id, model, {}, "stop"));
            }
          } else {
            send(sseChunk(id, model, {}, "stop"));
          }
          const usage = usageFromResult(result);
          if (usage) {
            send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
            const d = usage.prompt_tokens_details;
            const uncached = usage.prompt_tokens - d.cached_tokens - d.cache_write_tokens;
            console.log(`[usage] model=${model} prompt=${usage.prompt_tokens} cached=${d.cached_tokens} cache_write=${d.cache_write_tokens} uncached=${uncached} out=${usage.completion_tokens}`);
          }
          send("data: [DONE]\n\n");
        } catch (e) {
          console.error("[err]", e);
          send(`data: ${JSON.stringify({ error: { message: String(e) } })}\n\n`);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  },
});

console.log(`claude-shim listening on 127.0.0.1:${PORT} (tools: prompt-contract, one cli per chat, maxLive=${MAX_LIVE}, idleTtl=${IDLE_TTL_MS/1000}s)`);
