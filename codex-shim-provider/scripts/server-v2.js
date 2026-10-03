#!/usr/bin/env bun
// codex-shim v2 — OpenAI-compatible chat/completions proxy over `codex app-server`
// (long-lived JSON-RPC process, the same protocol the VS Code extension uses).
//
// vs v1 (codex exec): real token streaming, reasoning summary deltas live,
// native dynamic tools (no TOOL_CALL text contract), model list via model/list,
// threads stay loaded in the server (no per-turn process spawn).
//
// Env:
//   SHIM_PORT        (default 8321)
//   CODEX_BIN        (default ~/.local/bin/codex)
//   CODEX_WORKDIR    (default ~/codex-shim/workdir)
//   SHIM_SESSIONS_DIR(default ~/codex-shim/sessions) — key→threadId state
//   SHIM_MODELS      (comma list override; default from model/list)
//   SHIM_SANDBOX     read-only | workspace-write (default) | danger-full-access
//   SHIM_DEBUG=1     verbose logging

import { spawn } from "bun";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { NoticeTransport, noticeText, noticeFrame } from "./notice-transport.js";
const noticeTransport = new NoticeTransport();
const threadOwners = new Map();

const PORT = Number(process.env.SHIM_PORT || 8321);
const HOME = process.env.HOME;
const CODEX_BIN = process.env.CODEX_BIN || join(HOME, ".local/bin/codex");
const WORKDIR = process.env.CODEX_WORKDIR || join(HOME, "codex-shim/workdir");
const SESS_DIR = process.env.SHIM_SESSIONS_DIR || join(HOME, "codex-shim/sessions");
const SANDBOX = process.env.SHIM_SANDBOX || "workspace-write";
const DEBUG = !!process.env.SHIM_DEBUG;

mkdirSync(SESS_DIR, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

const sha1 = s => createHash("sha1").update(s).digest("hex");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => DEBUG && log(...a);

// ---------- app-server client ----------
class AppServer {
  constructor() { this.proc = null; this.idc = 0; this.pending = new Map(); this.onServerRequest = null; this.onNotification = null; this.modelList = []; }
  start() {
    log("[appserver] starting", CODEX_BIN);
    this.proc = spawn({ cmd: [CODEX_BIN, "app-server"], stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CODEX_HOME: join(HOME, ".codex") } });
    this.readLoop();
    this.proc.exited.then(code => {
      log("[appserver] exited", code, "— failing pending and restarting");
      for (const [, p] of this.pending) p.rej(new Error("app-server died"));
      this.onExit?.(code);
      this.pending.clear();
      setTimeout(() => this.start(), 2000);
    });
    new Response(this.proc.stderr).text().then(t => t && dbg("[appserver stderr]", t.slice(-2000)));
  }
  async readLoop() {
    const reader = this.proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && m.method) {
          // server-initiated request — handle async, NEVER block the read loop
          // (parked tool calls return a never-resolving promise on purpose)
          Promise.resolve().then(() => this.onServerRequest?.(m))
            .then(result => this.respond(m.id, result))
            .catch(e => this.proc.stdin.write(JSON.stringify({ id: m.id, error: { code: -32000, message: String(e) } }) + "\n"));
        } else if (m.id != null) {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result); }
        } else if (m.method) {
          this.onNotification?.(m.method, m.params || {});
        }
      }
    }
  }
  respond(id, result) { this.proc.stdin.write(JSON.stringify({ id, result }) + "\n"); }
  request(method, params) {
    const id = ++this.idc;
    this.proc.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async init() {
    await this.request("initialize", { clientInfo: { name: "codex-shim", version: "2.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    try {
      const r = await this.request("model/list", {});
      const arr = r?.data || r?.models || r?.items || [];
      this.modelList = arr.filter(m => !m.hidden).map(m => m.id || m.model || m.slug).filter(Boolean);
      this.modelEfforts = Object.fromEntries(arr.map(m => [m.id || m.model || m.slug,
        (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort || e).filter(Boolean)]));
      log("[appserver] models:", this.modelList.join(",") || "(none reported)");
    } catch (e) { log("[appserver] model/list failed:", String(e)); }
  }
}

const srv = new AppServer();
srv.start();
(async () => { for (let i = 0; i < 10; i++) { try { await srv.init(); break; } catch (e) { log("[appserver] init retry", i, String(e).slice(0, 120)); await new Promise(r => setTimeout(r, 1500)); } } })();

// per-thread handler registry (multiple concurrent conversations)
const threadHandlers = new Map(); // threadId -> { notif(method,p), request(m) }
const liveThreads = new Set();    // threads loaded in the current app-server process
srv.onExit = code => {
  for (const [tid, owner] of threadOwners) {
    noticeTransport.queue(owner.key, noticeText("codex-shim", "CLI завершён", `${owner.model}; код=${code}`));
    threadHandlers.get(tid)?.notif("turn/completed", {turn:{status:"failed",error:{message:`app-server exited (${code})`}}});
  }
  liveThreads.clear(); threadOwners.clear();
};
srv.onNotification = (method, p) => {
  const h = p.threadId && threadHandlers.get(p.threadId);
  if (h) h.notif(method, p);
};
srv.onServerRequest = async m => {
  const h = m.params?.threadId && threadHandlers.get(m.params.threadId);
  if (h) return h.request(m);
  if (m.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  if (m.method === "item/tool/call") log(`[guard] ⚠ tool call for thread with NO live handler (thread=${m.params?.threadId}) — answering EMPTY, model will see nothing`);
  else dbg("[unhandled server request]", m.method);
  return {};
};

function models() {
  if (process.env.SHIM_MODELS) return process.env.SHIM_MODELS.split(",").map(s => s.trim()).filter(Boolean);
  return srv.modelList.length ? srv.modelList : ["gpt-5.5"];
}

// ---------- per-chat state ----------
function sessPath(key) { return join(SESS_DIR, sha1(key) + ".json"); }
function loadState(key) { try { return JSON.parse(readFileSync(sessPath(key), "utf8")); } catch { return null; } }
function saveState(key, st) { writeFileSync(sessPath(key), JSON.stringify(st)); }

// router-oneuse-<uuid> keys come from shim-router for Vellum internal call sites:
// one logical task per key. State lives ONLY in memory (never in SESS_DIR, so one-use
// threads never show in /chats monitoring), the thread is dropped right after its turn
// completes, and an idle reaper sweeps tasks abandoned mid tool round trip.
const ONEUSE_RE = /^router-oneuse-/;
const oneUseStates = new Map(); // key -> state (memory only)
const ONEUSE_IDLE_MS = Number(process.env.SHIM_ONEUSE_IDLE_MS ?? 15 * 60e3);
function persistState(key, st) {
  if (!key || !st) return;
  if (ONEUSE_RE.test(key)) { st.lastUsedAt = Date.now(); oneUseStates.set(key, st); return; }
  saveState(key, st);
}
function destroyOneUseState(key, st, reason) {
  oneUseStates.delete(key);
  if (!st?.threadId) return;
  liveThreads.delete(st.threadId);
  threadHandlers.delete(st.threadId);
  // The app-server process is shared by all chats, so it cannot be killed per request.
  // thread/delete is the protocol-level equivalent: the one-use thread is actually
  // released upstream instead of merely disappearing from our maps.
  void srv.request("thread/delete", { threadId: st.threadId })
    .then(() => log(`[oneuse] ${reason}: thread deleted ${st.threadId}`))
    .catch(e => log(`[oneuse] ${reason}: thread/delete failed ${String(e).slice(0, 160)}`));
}
setInterval(() => {
  for (const [k, st] of oneUseStates) {
    if (Date.now() - (st.lastUsedAt ?? 0) > ONEUSE_IDLE_MS) {
      destroyOneUseState(k, st, "idle reaped");
    }
  }
}, 60_000);

// system prompt (no tools contract — tools are native now)
function systemText(messages) {
  return (messages || []).filter(m => m.role === "system" || m.role === "developer")
    .map(m => typeof m.content === "string" ? m.content : (m.content || []).map(p => p.text || "").join("\n"))
    .join("\n\n");
}

function blocksOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      const c = typeof m.content === "string" ? m.content : (m.content || []).map(p => p.type === "text" ? p.text : "").join("\n");
      if (c.trim()) out.push({ kind: "user", text: c });
    } else if (m.role === "tool") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      out.push({ kind: "tool", id: m.tool_call_id || "", text: c });
    }
  }
  return out;
}
const blockHash = b => sha1(b.kind + ":" + b.id + ":" + b.text);
const toolsHash = tools => sha1(JSON.stringify((tools || []).map(t => t.function?.name)));

// ---------- HTTP ----------
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
const cid = () => "chatcmpl-" + Math.random().toString(36).slice(2);
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function handleChat(req) {
  const body = await req.json();
  const model = body.model || models()[0];
  const messages = body.messages || [];
  const tools = body.tools || null;
  const id = cid();
  const t0 = Date.now();

  const sys = systemText(messages);
  const fingerprint = sha1(sys + "|" + toolsHash(tools));
  const blocks = blocksOf(messages);

  // Session key: explicit prompt_cache_key → X-Conversation-Id header (local Vellum
  // patch in providers/retry.ts). NO silent fallback: a keyless request would mean a
  // fresh thread + full history replay on every call and unanswerable parked tool
  // calls (the Oct 1 quota burn). Fail fast instead. SHIM_ALLOW_KEYLESS=1 re-enables
  // a derived key (first user block hash) for manual debugging only.
  const headerKey = req.headers.get("x-conversation-id") || null;
  const firstUser = blocks.find(b => b.kind === "user");
  const derivedKey = process.env.SHIM_ALLOW_KEYLESS && firstUser ? "derived-" + sha1(fingerprint + "|" + firstUser.text) : null;
  const keySrc = body.prompt_cache_key ? "body" : headerKey ? "header" : derivedKey ? "derived" : "-";
  const key = body.prompt_cache_key || headerKey || derivedKey;
  log(`[req] model=${model} key=${key ? key.slice(0, 12) : "-"}(${keySrc}) msgs=${messages.length} blocks=${blocks.length} tools=${tools ? tools.length : 0}`);
  if (!key) {
    log("[req] REJECTED: no session key (prompt_cache_key / X-Conversation-Id). Is the Vellum retry.ts patch applied + daemon restarted?");
    return jsonResp({ error: { message: "codex-shim: no session key. Send prompt_cache_key or X-Conversation-Id header (Vellum: apply skills/codex-shim-provider/scripts/patch-vellum-retry.sh and restart the daemon). Refusing to run keyless: it would replay the whole history per request and burn quota.", type: "invalid_request_error", code: "missing_session_key" } }, 400);
  }

  // Effort: validate, never guess. An explicit value must be one the model advertises
  // (model/list.supportedReasoningEfforts); otherwise 400 before any inference.
  const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const requestedEffort = body.reasoning_effort ?? body.reasoning?.effort ?? null;
  const supportedEfforts = (srv.modelEfforts || {})[model];
  const allowedEfforts = supportedEfforts && supportedEfforts.length ? supportedEfforts : KNOWN_EFFORTS;
  if (requestedEffort !== null && (typeof requestedEffort !== "string" || !allowedEfforts.includes(requestedEffort))) {
    log(`[req] REJECTED: effort ${JSON.stringify(requestedEffort)} not supported by ${model} (allowed: ${allowedEfforts.join(",")})`);
    return jsonResp({ error: { message: `codex-shim: effort ${JSON.stringify(requestedEffort)} is not supported by model ${model}; allowed: ${allowedEfforts.join(", ")}`, type: "invalid_request_error", code: "unsupported_effort" } }, 400);
  }
  const effort = requestedEffort ?? process.env.SHIM_DEFAULT_EFFORT ?? "high";

  const oneUse = ONEUSE_RE.test(key);
  let state = oneUse ? (oneUseStates.get(key) ?? null) : key ? loadState(key) : null;
  let prevState = null, invalidReason = null;
  if (state && (state.model !== model || state.fingerprint !== fingerprint)) {
    prevState = state;
    invalidReason = [
      state.model !== model ? `model ${state.model} -> ${model}` : null,
      state.fingerprint !== fingerprint ? `fingerprint ${String(state.fingerprint).slice(0, 8)} -> ${fingerprint.slice(0, 8)}` : null,
    ].filter(Boolean).join("; ");
    state = null;
  }

  // blocks the thread hasn't seen yet
  let toFeed = blocks;
  if (state) {
    const seen = new Set(state.sent);
    toFeed = blocks.filter(b => !seen.has(blockHash(b)));
  }

  // guard: many UNSEEN blocks at once == probable full-history replay (the Oct 1 quota
  // burn). Counts only blocks the thread has never seen (assistant blocks are never
  // fed; retry replays below don't re-trigger this).
  const feedCount = toFeed.length;
  const feedChars = toFeed.reduce((n, b) => n + b.text.length, 0);
  const MAX_FEED = Number(process.env.SHIM_MAX_FEED || 8);
  if (feedCount > MAX_FEED) {
    log(`[guard] ⚠ REPLAY-SUSPECT key=${key.slice(0, 12)} feeding ${feedCount} unseen blocks (~${feedChars} chars) at once (limit ${MAX_FEED}) newThread=${!state} model=${model} — full-history replay?`);
  }

  // tool results pending from a previous request?
  let toolResults = toFeed.filter(b => b.kind === "tool");
  let userBlocks = toFeed.filter(b => b.kind === "user");
  if (!userBlocks.length && !toolResults.length) {
    // Everything was already fed but the caller asks again: the previous answer
    // was lost (shim/app-server restart mid-turn, client retry, dropped stream).
    // Replay the trailing unanswered block(s) as a new turn instead of 400-ing.
    const lastUserIdx = blocks.map(b => b.kind).lastIndexOf("user");
    const tail = blocks.slice(lastUserIdx >= 0 ? lastUserIdx : 0);
    const tailTools = tail.filter(b => b.kind === "tool");
    const stillParked = tailTools.length && tailTools.every(b => state && state.parked && state.parked[b.id]);
    if (stillParked) { toolResults = tailTools; userBlocks = []; }
    else if (tailTools.length) {
      // parked call is gone (app-server restart) → hand the results over as plain text
      toolResults = []; userBlocks = [{ kind: "user", text: "Tool results (replayed after restart):\n" + tailTools.map(b => b.text).join("\n\n") }];
    } else { toolResults = []; userBlocks = tail.filter(b => b.kind === "user"); }
    log(`[req] retry: nothing unseen, replaying last ${stillParked ? "tool results (parked)" : tailTools.length ? "tool results as text" : "user block"}`);
    if (!userBlocks.length && !toolResults.length) {
      return jsonResp({ error: { message: "nothing new to feed", type: "invalid_request_error" } }, 400);
    }
  }
  const prompt = userBlocks.map(b => b.text).join("\n\n");

  const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" };
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const res = { write: s => { if (!closed) controller.enqueue(enc.encode(s)); }, close: () => { if (!closed) controller.close(); } };
      const fail = msg => {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: "⚠ codex: " + String(msg).slice(0, 500) } }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n"); res.close();
      };
      const noticed = new Set();
      const notice = (event, detail) => {
        const txt = noticeText("codex-shim", event, detail);
        if (noticed.has(txt)) return;
        noticed.add(txt); log(`[guard] ${txt}`); res.write(noticeFrame(txt));
      };
      try {
        // --- ensure thread ---
        if (!state) {
          log(`[guard] NEW THREAD key=${key.slice(0, 12)} reason=${invalidReason ? "state invalidated: " + invalidReason : "no prior state"} feed=${feedCount} blocks (~${feedChars} chars) sys=${sys.length} chars tools=${tools ? tools.length : 0}`);
          if (prevState) log(`[guard] DIFF prev: thread=${prevState.threadId} model=${prevState.model} sent=${(prevState.sent || []).length} blocks fp=${String(prevState.fingerprint).slice(0, 8)}`);
          if (prevState) notice("Сессия заменена", [prevState.model !== model ? `${prevState.model} → ${model}` : null, prevState.fingerprint !== fingerprint ? "настройки изменились" : null].filter(Boolean).join("; "));
          const dynTools = (tools || []).map(t => ({ type: "function", name: t.function.name,
            description: t.function.description || "", inputSchema: t.function.parameters || { type: "object" } }));
          const r = await srv.request("thread/start", {
            model, cwd: WORKDIR, approvalPolicy: "never", sandbox: SANDBOX,
            baseInstructions: sys || undefined,
            // Disable codex's INVISIBLE native tools: shell/unified_exec run inside
            // app-server (we see nothing, only the rollout file shows them) and
            // multi_agent spawns sub-agents silently. With them off the model uses the
            // caller's dynamic tools (Vellum `bash` etc.) which we park + log.
            // SHIM_NATIVE_TOOLS=1 re-enables them.
            config: { model_reasoning_summary: "detailed", show_raw_agent_reasoning: true,
              ...(process.env.SHIM_NATIVE_TOOLS ? {} : { features: { shell_tool: false, unified_exec: false, multi_agent: false } }) },
            dynamicTools: dynTools.length ? dynTools : undefined,
            ephemeral: key ? undefined : true,
          });
          const threadId = r.thread.id;
          liveThreads.add(threadId);
          if (!oneUse) threadOwners.set(threadId, {key, model});
          notice("Старт", `${model}; с нуля`);
          state = { threadId, sent: [], model, fingerprint, parked: {} };
          persistState(key, state);
          log("[guard] thread started:", threadId, "model:", model);
        } else if (!liveThreads.has(state.threadId)) {
          // thread not loaded in this app-server process (we restarted) — reload from disk
          log(`[guard] RESUME thread=${state.threadId} key=${key.slice(0, 12)} alreadyFed=${(state.sent || []).length} new=${feedCount} (${userBlocks.length} user + ${toolResults.length} tool) parked=${Object.keys(state.parked || {}).length}`);

          try {
            await srv.request("thread/resume", { threadId: state.threadId, excludeTurns: true });
            liveThreads.add(state.threadId);
            if (!oneUse) threadOwners.set(state.threadId, {key, model});
            notice("Старт", `${model}; из файла; видено=${state.sent?.length || 0}`);
            if (Object.keys(state.parked || {}).length) notice("Потеря tool call", `${Object.keys(state.parked).length}`);
            state.parked = {}; // rpc ids died with the old process
          } catch (e) {
            log("[sess] resume failed, fresh thread:", String(e).slice(0, 120));
            try { unlinkSync(sessPath(key)); } catch {}
            notice("Восстановление не удалось", `${model}; повторите запрос`);
            return fail("thread lost after restart, please retry");
          }
        }

        if (!oneUse) threadOwners.set(state.threadId, {key, model});
        if (feedCount > MAX_FEED) notice("Большой контекст", `${model}; +${feedCount} блоков; видено=${blocks.length-feedCount}/${blocks.length}`);
        // --- run turn (handlers FIRST — answering a parked call resumes the turn immediately) ---
        const parkedCalls = [];
        const usage = { input: 0, output: 0, cached: 0, reasoning: null };
        let agentBuf = "";
        let done = false, turnError = null;
        // turn telemetry: explains post-hoc where the time went ("what was ChatGPT doing")
        const tTurn = Date.now();
        const elapsed = () => "+" + ((Date.now() - tTurn) / 1000).toFixed(1) + "s";
        let sawReasoning = false, sawText = false, reasoningChars = 0, summaryBuf = "";
        let hasReadableReasoning = false;
        const streamedReasoningItems = new Set();
        const emitReasoning = (text, itemId) => {
          if (typeof text !== "string" || !text) return;
          if (text.trim()) {
            hasReadableReasoning = true;
            if (itemId) streamedReasoningItems.add(itemId);
          }
          if (!sawReasoning) { sawReasoning = true; log(`[turn] ${elapsed()} first reasoning`); }
          reasoningChars += text.length;
          sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: text } }] });
        };

        threadHandlers.set(state.threadId, {
          notif: (method, p) => {
            dbg("[notif]", method, method === "item/agentMessage/delta" ? "" : JSON.stringify(p).slice(0, 150));
            if (method === "item/agentMessage/delta") {
              if (!sawText) { sawText = true; log(`[turn] ${elapsed()} first text`); }
              agentBuf += p.delta;
              if (!tools) sse(res, { ...base, choices: [{ index: 0, delta: { content: p.delta } }] });
            } else if (method === "item/reasoning/summaryTextDelta") {
              summaryBuf += p.delta || "";
              emitReasoning(p.delta, p.itemId);
            } else if (method === "item/reasoning/textDelta") {
              // Only forward text actually exposed by the model, never encrypted_content.
              emitReasoning(p.delta, p.itemId);
            } else if (method === "item/reasoning/summaryPartAdded") {
              if (summaryBuf.trim()) log(`[turn] ${elapsed()} summary: ${summaryBuf.trim().slice(0, 120)}`);
              summaryBuf = "";
              sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: "\n\n" } }] });
            } else if (method === "item/completed" && p.item?.type === "reasoning") {
              // Some transports deliver only a final item, without summary deltas.
              // Don't duplicate a summary/raw text that was already streamed.
              if (p.item.id ? !streamedReasoningItems.has(p.item.id) : !hasReadableReasoning) {
                const textOf = parts => (Array.isArray(parts) ? parts : [])
                  .filter(text => typeof text === "string").join("\n\n");
                const summary = textOf(p.item.summary);
                emitReasoning(summary.trim() ? summary : textOf(p.item.content), p.item.id);
              }
            } else if (method === "thread/tokenUsage/updated" && p.tokenUsage?.last) {
              usage.input = p.tokenUsage.last.inputTokens ?? usage.input;
              usage.output = p.tokenUsage.last.outputTokens ?? usage.output;
              usage.cached = p.tokenUsage.last.cachedInputTokens ?? usage.cached;
              // last is this model step; total is the entire thread, not this response.
              const reasoning = p.tokenUsage.last.reasoningOutputTokens;
              usage.reasoning = Number.isSafeInteger(reasoning) && reasoning >= 0 ? reasoning : null;
            } else if (method === "turn/completed") {
              done = true;
              log(`[turn] ${elapsed()} completed status=${p.turn?.status || "?"} reasoning=${reasoningChars}ch reasoningTokens=${usage.reasoning ?? "?"} text=${agentBuf.length}ch`);
              if (p.turn?.status === "failed" || p.turn?.error) turnError = p.turn?.error?.message || JSON.stringify(p.turn?.error || "turn failed");
            }
          },
          request: async m => {
            if (m.method === "item/tool/call") {
              // park: ends this HTTP response as tool_calls; answered by a later request
              const callId = "call_" + Math.random().toString(36).slice(2);
              state.parked[callId] = { rpcId: m.id, name: m.params.tool };
              parkedCalls.push({ callId, name: m.params.tool, arguments: m.params.arguments });
              log(`[tool] parked ${m.params.tool}`);
              persistState(key, state);
              return new Promise(() => {}); // never resolved here; answered via srv.respond later
            }
            if (m.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
            if (m.method.endsWith("requestApproval") || m.method === "applyPatchApproval" || m.method === "execCommandApproval") {
              dbg("[approval auto-accept]", m.method);
              return { decision: "accept" };
            }
            return {};
          },
        });

        // --- answer parked tool calls, if any (resumes the paused turn) ---
        if (Object.keys(state.parked || {}).length && toolResults.length) {
          for (const tr of toolResults) {
            const parked = state.parked[tr.id];
            if (parked) {
              log(`[tool] answering parked rpcId=${parked.rpcId} name=${parked.name}`);
              srv.respond(parked.rpcId, { contentItems: [{ type: "inputText", text: tr.text }], success: true });
              delete state.parked[tr.id];
            }
          }
          persistState(key, state);
        }

        if (prompt.trim()) {
          // effort: Vellum sends OpenAI-style reasoning_effort (or reasoning.effort); summary:
          // reasoning summaries must be requested per turn or codex emits empty reasoning items.
          log(`[effort] model=${model} requested=${requestedEffort ?? "default"} effective=${effort}`);
          await srv.request("turn/start", {
            threadId: state.threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            summary: process.env.SHIM_REASONING_SUMMARY || "detailed",
            ...(effort ? { effort: String(effort) } : {}),
          });
        }
        // mark fed
        state.sent = blocks.map(blockHash);
        persistState(key, state);

        // wait for turn completion (or first parked tool call); heartbeat every 15s so a
        // long silent turn (encrypted reasoning at high effort) is visible in the journal
        const deadline = Date.now() + 180000;
        let lastBeat = Date.now();
        while (!done && Date.now() < deadline) {
          if (parkedCalls.length) {
            await new Promise(r => setTimeout(r, 300)); // let chained calls park too
            break;
          }
          if (Date.now() - lastBeat > 15000) {
            lastBeat = Date.now();
            log(`[turn] ${elapsed()} still running (reasoning=${reasoningChars}ch text=${agentBuf.length}ch)`);
          }
          await new Promise(r => setTimeout(r, 120));
        }
        if (!done && !parkedCalls.length) log(`[turn] ${elapsed()} TIMEOUT waiting for turn completion`);

        // Wait until the response boundary to choose the fallback: a real summary
        // may arrive after usage. Emit once, before finish/tool_calls, including on
        // tool pauses and failed turns. A blank summary separator isn't real thinking.
        // Usage is reported after a model step, not continuously while it is thinking.
        if (!hasReadableReasoning && usage.reasoning > 0) {
          sse(res, { ...base, choices: [{ index: 0, delta: {
            reasoning_content: `[codex-shim] Reasoning: ${usage.reasoning} токенов. Summary недоступна.\n`,
          } }] });
          log(`[turn] ${elapsed()} thinking fallback reasoningTokens=${usage.reasoning}`);
        }

        const finish = fr => sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: fr }] });
        if (parkedCalls.length) {
          const tc = parkedCalls.map((c, i) => ({ index: i, id: c.callId, type: "function",
            function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } }));
          if (tools && agentBuf) sse(res, { ...base, choices: [{ index: 0, delta: { content: agentBuf } }] });
          sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: tc } }] });
          finish("tool_calls");
          log(`[res] tool_calls=${parkedCalls.map(c => c.name).join(",")} ${Date.now() - t0}ms`);
        } else if (turnError) {
          notice("Ошибка CLI", `${model}; ${String(turnError).slice(0, 120)}`);
          sse(res, { ...base, choices: [{ index: 0, delta: { content: agentBuf ? "" : "⚠ codex: " + String(turnError).slice(0, 500) } }] });
          finish("stop");
        } else {
          if (tools && agentBuf) sse(res, { ...base, choices: [{ index: 0, delta: { content: agentBuf } }] });
          finish("stop");
        }
        if (usage.input || usage.output || usage.reasoning !== null) {
          sse(res, { ...base, choices: [], usage: {
            prompt_tokens: usage.input, completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            prompt_tokens_details: { cached_tokens: usage.cached },
            ...(usage.reasoning !== null ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
          }});
        }
        res.write("data: [DONE]\n\n");
        res.close();
        closed = true;
        threadHandlers.delete(state.threadId);
        if (oneUse) {
          if (parkedCalls.length) {
            persistState(key, state); // tool round trip pending: keep state in memory until it lands
          } else {
            destroyOneUseState(key, state, "turn done");
            log(`[oneuse] ${key.slice(0, 32)} turn done — thread deleted, nothing persisted`);
          }
        }
        log(`[res] ${agentBuf.length} chars parked=${parkedCalls.length} ${Date.now() - t0}ms`);
      } catch (e) {
        log("[err]", e);
        fail(e);
      }
    },
  });
  return new Response(stream, { headers });
}

function saveStateAndRethrow(key, st) { persistState(key, st); }

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) { return noticeTransport.fetch(req, handleRequest); },
});
async function handleRequest(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return jsonResp({ object: "list", data: models().map(m => ({ id: m, object: "model", created: 0, owned_by: "codex-cli" })) });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try { return await handleChat(req); }
      catch (e) { log("[err]", e); return jsonResp({ error: { message: String(e), type: "server_error" } }, 500); }
    }
    if (url.pathname === "/chats") {
      const { readdirSync, statSync } = await import("fs");
      const chats = readdirSync(SESS_DIR).filter(f => f.endsWith(".json")).map(f => {
        const st = JSON.parse(readFileSync(join(SESS_DIR, f), "utf8"));
        return { file: f, model: st.model, threadId: st.threadId, parked: Object.keys(st.parked || {}).length,
          ageMin: Math.round((Date.now() - statSync(join(SESS_DIR, f)).mtimeMs) / 60000) };
      });
      return jsonResp({ chats });
    }
    return jsonResp({ error: "not found" }, 404);
}

log(`codex-shim v2 listening on 127.0.0.1:${PORT} (app-server, sandbox=${SANDBOX})`);
