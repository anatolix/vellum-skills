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
import { NoticeTransport, noticeText, noticeFrame, isCompactionRequest } from "./notice-transport.js";
import { promptForSession } from "./history-rehydration.js";
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
      env: { ...process.env, CODEX_HOME: process.env.SHIM_CODEX_HOME || join(HOME, ".codex") } });
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
      const sl0 = await this.request("skills/list", {});
      const found = [];
      const walk = o => { if (!o) return; if (Array.isArray(o)) return o.forEach(walk);
        if (typeof o === "object") { if (o.name && (o.path || o.enabled !== undefined)) found.push({ name: o.name, path: o.path || null });
          Object.values(o).forEach(walk); } };
      walk(sl0);
      for (const sk of found) {
        try { await this.request("skills/config/write", { ...(sk.path ? { path: sk.path } : { name: sk.name }), enabled: false }); }
        catch (e) { log("[skills] disable", sk.name, "failed:", String(e).slice(0, 120)); }
      }
      if (found.length) log(`[skills] disabled ${found.length} codex skill(s): ${found.map(x => x.name).join(",")}`);
    } catch (e) { log("[skills] list/disable skipped:", String(e).slice(0, 120)); }
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
const compactLocks = new Map();   // threadId -> Promise: native compaction in flight; turns wait for it
async function awaitCompactLock(threadId, tag) {
  const p = compactLocks.get(threadId); if (!p) return;
  const t0 = Date.now(); log(`[compact] ${tag} turn waits for native compaction`);
  await Promise.race([p, new Promise(r => setTimeout(r, 200000))]);
  log(`[compact] ${tag} wait over after ${Date.now() - t0}ms`);
}
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
// When rewritten history is detected, dump the skipped blocks (full new text + what the
// thread had at that position: hash/len/head/tail) so the cause of the rewrite can be
// analysed later. One JSON per event + index.jsonl summary.
const HE_DIR = process.env.SHIM_HISTEDIT_DIR || join(HOME, "codex-shim/history-edits");
const blockMeta = b => ({ len: b.text.length, head: b.text.slice(0, 300), tail: b.text.slice(-200) });
function dumpHistoryEdit(tag, info, blocks, hashes, skippedIdx, lastSeen, prevSent, prevMeta) {
  try {
    mkdirSync(HE_DIR, { recursive: true });
    const at = new Date().toISOString();
    const rec = { at, ...info, blocks: blocks.length, prevBlocks: prevSent.length, aligned: blocks.length === prevSent.length, lastSeen,
      skipped: skippedIdx.map(i => { const b = blocks[i], ph = prevSent[i] ?? null; return { index: i, kind: b.kind || b.role, id: b.id || null, hash: hashes[i].slice(0, 12), len: b.text.length, text: b.text,
        prevAtIndex: ph ? { hash: ph.slice(0, 12), ...(prevMeta[ph] || {}) } : null }; }) };
    const stamp = at.replace(/[:.]/g, "-") + "-" + tag;
    writeFileSync(join(HE_DIR, stamp + ".json"), JSON.stringify(rec, null, 1));
    const kinds = rec.skipped.map(s => s.kind + "#" + s.index + (s.prevAtIndex?.len != null ? `(${s.prevAtIndex.len}->${s.len})` : "(?)")).join(",");
    writeFileSync(join(HE_DIR, "index.jsonl"), JSON.stringify({ at, ...info, skipped: skippedIdx.length, chars: rec.skipped.reduce((n, s) => n + s.len, 0), aligned: rec.aligned, kinds, file: stamp + ".json" }) + "\n", { flag: "a" });
    log(`[guard] HISTORY-EDIT dump ${stamp}.json ${kinds}`);
  } catch (e) { log("[guard] history-edit dump failed", String(e).slice(0, 120)); }
}

// Client-dependent tools (platform/host-proxy tools that Vellum adds or removes depending on
// which device is connected: request_system_permission, ask_question, host_*) must NOT change
// the thread fingerprint — a phone<->laptop switch would otherwise kill the codex thread and
// re-feed the whole history (Oct 4: 224 blocks / 268K chars for one flip). They are still
// offered to the thread (union of this request + every volatile tool seen before), and a call
// to one the current request lacks is answered with an error instead of being parked.
const VOLATILE_TOOLS = new Set((process.env.SHIM_VOLATILE_TOOLS || "request_system_permission,ask_question").split(",").map(x => x.trim()).filter(Boolean));
const isVolatileTool = n => VOLATILE_TOOLS.has(n) || /^host_/.test(n || "");
const stableToolNames = tools => (tools || []).map(t => t.function?.name).filter(n => !isVolatileTool(n));
const toolsHash = tools => sha1(JSON.stringify(stableToolNames(tools)));
const legacyToolsHash = tools => sha1(JSON.stringify((tools || []).map(t => t.function?.name))); // pre-Oct-4 fingerprint, for one-time state migration
const VOLATILE_FILE = join(SESS_DIR, "volatile-tools.json");
function rememberVolatileTools(tools) {
  let seen = {}; try { seen = JSON.parse(readFileSync(VOLATILE_FILE, "utf8")); } catch {}
  let changed = false;
  for (const t of tools || []) { const n = t.function?.name; if (isVolatileTool(n) && !seen[n]) { seen[n] = t; changed = true; } }
  if (changed) { try { writeFileSync(VOLATILE_FILE, JSON.stringify(seen)); } catch (e) { log("[tools] volatile save failed", String(e).slice(0, 100)); } }
  return seen;
}
// What exactly broke the fingerprint: short text for the red notice + full record on disk.
const FP_DIR = process.env.SHIM_FP_DIR || join(HOME, "codex-shim/fp-changes");
function fpDiff(prev, sys, names, key) {
  const parts = [], rec = { at: new Date().toISOString(), key: key.slice(0, 12), thread: prev.threadId, sent: (prev.sent || []).length };
  const old = prev.toolNames;
  if (!old) parts.push("старая сессия без данных о промпте/инструментах");
  else {
    const add = names.filter(n => !old.includes(n)), del = old.filter(n => !names.includes(n));
    const lst = (sign, a) => sign + a.slice(0, 2).join(" " + sign) + (a.length > 2 ? ` +ещё ${a.length - 2}` : "");
    if (add.length || del.length) {
      parts.push(`инструменты ${old.length}→${names.length}` + (del.length ? " " + lst("−", del) : "") + (add.length ? " " + lst("+", add) : ""));
    } else if (JSON.stringify(old) !== JSON.stringify(names)) parts.push("порядок инструментов");
    rec.toolsAdded = add; rec.toolsRemoved = del;
  }
  if (typeof prev.sys === "string" && prev.sys !== sys) {
    const a = prev.sys.split("\n"), b = sys.split("\n");
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const d = sys.length - prev.sys.length;
    parts.push(`промпт ${d >= 0 ? "+" : ""}${d} симв., строка ${i + 1}`);
    rec.sysLenOld = prev.sys.length; rec.sysLenNew = sys.length; rec.firstDiffLine = i + 1;
    rec.oldLine = (a[i] ?? "").slice(0, 300); rec.newLine = (b[i] ?? "").slice(0, 300);
  }
  try {
    mkdirSync(FP_DIR, { recursive: true });
    const stamp = rec.at.replace(/[:.]/g, "-") + "-" + rec.key;
    if (typeof prev.sys === "string" && prev.sys !== sys) {
      writeFileSync(join(FP_DIR, stamp + ".old.txt"), prev.sys); writeFileSync(join(FP_DIR, stamp + ".new.txt"), sys);
      rec.files = stamp + ".{old,new}.txt";
    }
    writeFileSync(join(FP_DIR, "changes.jsonl"), JSON.stringify(rec) + "\n", { flag: "a" });
  } catch (e) { log("[fp] record failed", String(e).slice(0, 120)); }
  log(`[fp] ${JSON.stringify(rec)}`);
  return parts.join("; ") || "настройки изменились";
}

// ---------- compaction ----------
// The fork's model sometimes anchors <tail_start> on codex's own injected messages
// (<environment_context>), which Vellum's history does not contain. Validate the marker against
// the user blocks Vellum sent; if it resolves to nothing, substitute the second-to-last real
// user turn (timestamp from its <turn_context>, preview = text after the injected tags).
function blockPreview(text) {
  let t = text;
  while (t.startsWith("<") && t.includes("</")) { const m = t.match(/<\/[a-zA-Z_][\w-]*>\s*\n?/); if (!m || m.index === undefined) break; t = t.slice(m.index + m[0].length).trimStart(); }
  return t.slice(0, 120);
}
// Vellum's parser is a plain indexOf/regex scan for <compaction_result>/<summary>/<key_state>/<tail_start>.
// A summary that *talks about* those tags derails it (a literal "<tail_start" inside the text wins the
// regex -> empty attrs -> "unparseable response"). The model wrote the whole block, so re-parse it
// structurally (real <tail_start is the LAST one, real </summary> is the last one before it), neuter
// tag-like literals inside the bodies and rebuild.
const RESULT_TAG_RE = /<(\/?)(compaction_result|summary|key_state|tail_start|retained_images?)\b/gi;
const neuterResultTags = t => String(t ?? "").replace(RESULT_TAG_RE, "\u2039$1$2");
function sanitizeCompactionResult(text) {
  const o = text.indexOf("<compaction_result>"); if (o < 0) return { text, changed: false };
  const c = text.lastIndexOf("</compaction_result>");
  const inner = text.slice(o + "<compaction_result>".length, c > o ? c : undefined);
  const tailIdx = inner.lastIndexOf("<tail_start"); if (tailIdx < 0) return { text, changed: false };
  const sumOpen = inner.indexOf("<summary>"); if (sumOpen < 0) return { text, changed: false };
  const ksOpen = inner.lastIndexOf("<key_state>", tailIdx);
  const sumClose = inner.lastIndexOf("</summary>", ksOpen > sumOpen ? ksOpen : tailIdx); if (sumClose <= sumOpen) return { text, changed: false };
  const summary = inner.slice(sumOpen + "<summary>".length, sumClose).trim();
  let keyState = "";
  if (ksOpen > sumClose) { const ksClose = inner.lastIndexOf("</key_state>", tailIdx); if (ksClose > ksOpen) keyState = inner.slice(ksOpen + "<key_state>".length, ksClose).trim(); }
  const tailSeg = inner.slice(tailIdx).replace(/<\/compaction_result>[\s\S]*$/, "").trim();
  const rebuilt = `<compaction_result>\n<summary>\n${neuterResultTags(summary)}\n</summary>\n\n<key_state>\n${neuterResultTags(keyState)}\n</key_state>\n\n${tailSeg}\n</compaction_result>`;
  return { text: rebuilt, changed: rebuilt !== text, neutered: RESULT_TAG_RE.test(summary + keyState) };
}
const COMPACT_DUMP_DIR = `${process.env.HOME}/codex-shim/compact-dumps`;
function dumpCompaction(tag, text) {
  try { mkdirSync(COMPACT_DUMP_DIR, { recursive: true }); writeFileSync(`${COMPACT_DUMP_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.txt`, text); } catch {}
}
// Timestamp of a user message exactly the way Vellum's extractTurnContextTimestamp() sees it:
// `current_time:` inside the <turn_context> block, nothing else. Empty when the message has none
// ("/compact" slash commands, <system_notice> wrappers, tool-result-only turns).
function turnContextTime(text) {
  const i = text.indexOf("<turn_context>"); if (i < 0) return "";
  const e = text.indexOf("</turn_context>", i);
  const m = /current_time:\s*([^\n]+)/.exec(text.slice(i, e > 0 ? e : undefined));
  return m ? m[1].trim() : "";
}
function fixTailStart(text, blocks) {
  const users = blocks.filter(b => b.kind === "user"); users.pop(); // the instruction itself
  const m = /<tail_start[\s\S]*?timestamp="([^"]*)"[\s\S]*?preview="([^"]*)"[\s\S]*?\/>/.exec(text);
  if (!m) return { text, fixed: false };
  const ts = m[1].trim(), pv = m[2].trim().replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  const resolves = (ts && users.some(b => turnContextTime(b.text) === ts || b.text.includes(ts))) || (pv && blocks.some(b => blockPreview(b.text).startsWith(pv.slice(0, 40))));
  if (resolves) return { text, fixed: false };
  // Only messages with a <turn_context> resolve unambiguously on Vellum's side (see claude-shim).
  const dated = users.filter(b => turnContextTime(b.text));
  const tb = dated[dated.length - 2] ?? dated[dated.length - 1] ?? users[users.length - 2] ?? users[users.length - 1];
  if (!tb) return { text, fixed: false };
  const nts = turnContextTime(tb.text).replace(/"/g, "'");
  const npv = blockPreview(tb.text).slice(0, 60).replace(/\s+/g, " ").replace(/"/g, "'");
  return { text: text.replace(m[0], `<tail_start\n  timestamp="${nts}"\n  preview="${npv}" />`), fixed: true, was: `${ts || "-"} / ${pv.slice(0, 40) || "-"}` };
}
// Vellum asks the chat's own model to summarise the history (<compaction_instructions> as the
// trailing user message, tool_choice=none, expects <compaction_result>). Feeding that into the
// live thread would leave a "summarise yourself" turn in its history forever. Instead:
//   1) thread/fork the live thread (server-side copy, cached), run the instruction there,
//      stream the model's <compaction_result> back to Vellum, delete the fork;
//   2) thread/compact/start on the live thread so codex's own context shrinks too.
// Nothing is fed to the live thread and no block is marked seen. Vellum then replaces its
// history head with the summary; the rewritten tail is re-identified by tail match.
async function handleCompaction({ req, key, model, blocks, lastUserBlock, effort, id }) {
  const tag = key.slice(0, 12);
  const state = ONEUSE_RE.test(key) ? (oneUseStates.get(key) ?? null) : loadState(key);
  if (!state || !lastUserBlock) { log(`[compact] ${tag} REJECTED: no thread for this chat yet`); return jsonResp({ error: { message: "codex-shim: nothing to compact — no thread for this chat yet", type: "invalid_request_error", code: "no_thread" } }, 409); }
  // A parked tool call means the live turn is still open: fork for the summary anyway (fork copies
  // history server-side), skip the native compaction — it would fail on an active turn.
  const parkedNow = Object.keys(state.parked || {}).length;
  if (parkedNow) log(`[compact] ${tag} tool call in flight (${parkedNow}) — summary only, native compaction skipped`);
  if (compactLocks.has(state.threadId)) { log(`[compact] ${tag} REJECTED: compaction already running`); return jsonResp({ error: { message: "codex-shim: compaction already in progress", type: "invalid_request_error", code: "busy" } }, 409); }
  if (!liveThreads.has(state.threadId)) {
    try { await srv.request("thread/resume", { threadId: state.threadId, excludeTurns: true, config: { include_permissions_instructions: false } }); liveThreads.add(state.threadId); }
    catch (e) { log(`[compact] ${tag} resume failed: ${String(e).slice(0, 120)}`); return jsonResp({ error: { message: "codex-shim: thread could not be resumed for compaction", type: "server_error" } }, 503); }
  }
  log(`[compact] ${tag} thread=${state.threadId} model=${model} instruction=${lastUserBlock.text.length} chars blocks=${blocks.length}`);
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const enc = new TextEncoder();
  const stream = new ReadableStream({ async start(controller) {
    let closed = false;
    const res = { write: s => { if (!closed) controller.enqueue(enc.encode(s)); }, close: () => { if (!closed) { closed = true; controller.close(); } } };
    const ka = setInterval(() => res.write(": keepalive\n\n"), 15000);
    const usage = { input: 0, output: 0, cached: 0 };
    const timeFn = async m => (m.method === "currentTime/read" ? { currentTimeAt: Math.floor(Date.now() / 1000) } : {});
    try {
      // 1) side summary in a fork
      const fork = await srv.request("thread/fork", { threadId: state.threadId });
      const fid = fork.thread.id; liveThreads.add(fid);
      let text = "", done = false, turnError = null;
      threadHandlers.set(fid, {
        notif: (method, p) => {
          if (method === "item/agentMessage/delta") text += p.delta || "";
          else if (method === "thread/tokenUsage/updated") { const u = p.tokenUsage?.last || {}; usage.input = u.inputTokens || 0; usage.output = u.outputTokens || 0; usage.cached = u.cachedInputTokens || 0; }
          else if (method === "turn/completed") { done = true; if (p.turn?.status === "failed" || p.turn?.error) turnError = p.turn?.error?.message || JSON.stringify(p.turn?.error || "turn failed"); }
        },
        request: async m => {
          if (m.method === "item/tool/call") { log(`[compact] ${tag} fork tried tool ${m.params?.tool} — refused`); return { contentItems: [{ type: "inputText", text: "Tools are disabled during compaction. Answer in text only, in the requested format." }], success: false }; }
          return timeFn(m);
        },
      });
      const f0 = Date.now();
      await srv.request("turn/start", { threadId: fid, input: [{ type: "text", text: lastUserBlock.text, text_elements: [] }], summary: "concise", ...(effort ? { effort: String(effort) } : {}) });
      const deadline = Date.now() + 240000;
      while (!done && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
      threadHandlers.delete(fid); liveThreads.delete(fid);
      try { await srv.request("thread/delete", { threadId: fid }); } catch (e) { log(`[compact] ${tag} fork delete failed: ${String(e).slice(0, 100)}`); }
      if (!done) throw new Error("fork summary timed out");
      if (turnError) throw new Error(turnError);
      const ok = text.includes("<compaction_result>");
      if (ok) {
        const sz = sanitizeCompactionResult(text); if (sz.changed) { text = sz.text; if (sz.neutered) log(`[compact] ${tag} summary contained result-tag literals — neutered`); }
        const fx = fixTailStart(text, blocks); if (fx.fixed) { log(`[compact] ${tag} tail_start did not resolve (${fx.was}) — substituted second-to-last user turn`); text = fx.text; }
        dumpCompaction(tag, text);
      }
      log(`[compact] ${tag} fork summary ${text.length} chars in ${Date.now() - f0}ms valid=${ok} in=${usage.input} cached=${usage.cached} out=${usage.output}`);
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      sse(res, { ...base, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cached } } });
      res.write("data: [DONE]\n\n");
      res.close();
      // 2) native compaction of the live thread — detached from Vellum's stream (it already has the
      // summary); the next turn on this thread waits on compactLocks instead of hitting
      // ActiveTurnNotSteerable. Skipped while a tool call is parked (turn still open).
      if (ok && !parkedNow) {
        const done = (async () => {
          const c0 = Date.now(); let compacted = false, cFailed = null;
          const prevHandler = threadHandlers.get(state.threadId);
          threadHandlers.set(state.threadId, { notif: (method, p) => {
              if (method === "item/completed" && p.item?.type === "contextCompaction") compacted = true;
              if (method === "turn/completed") { if (p.turn?.status === "failed" || p.turn?.error) cFailed = p.turn?.error?.message || "compaction turn failed"; else compacted = compacted || true; }
            }, request: timeFn });
          try {
            await srv.request("thread/compact/start", { threadId: state.threadId });
            const cd = Date.now() + 180000;
            while (!compacted && !cFailed && Date.now() < cd) await new Promise(r => setTimeout(r, 150));
            log(`[compact] ${tag} native compaction ${compacted ? "done" : cFailed ? "FAILED: " + cFailed : "TIMEOUT"} in ${Date.now() - c0}ms`);
            const st = loadState(key) || state;
            // Model switching may have created a new thread while this detached compact
            // was running. Never write the old thread's completion into the new state.
            if (st.threadId !== state.threadId) { log(`[compact] ${tag} old-thread completion ignored (session replaced)`); return; }
            if (compacted) { st.compactedAt = Date.now(); st.compactions = (st.compactions || 0) + 1; }
            st.pendingCompactNotice = `${model}; summary ${text.length} симв.; тред ${compacted ? "сжат" : "НЕ сжат"} за ${Math.round((Date.now() - c0) / 1000)} с`;
            persistState(key, st);
          } catch (e) { log(`[compact] ${tag} native compaction error: ${String(e).slice(0, 120)}`); }
          finally { if (prevHandler) threadHandlers.set(state.threadId, prevHandler); else threadHandlers.delete(state.threadId); }
        })();
        compactLocks.set(state.threadId, done);
        done.finally(() => { if (compactLocks.get(state.threadId) === done) compactLocks.delete(state.threadId); });
      } else if (ok) {
        state.pendingCompactNotice = `${model}; summary ${text.length} симв.; тред НЕ сжат (tool call в полёте)`; persistState(key, state);
      }
    } catch (e) {
      log(`[compact] ${tag} ERROR ${String(e).slice(0, 200)}`);
      sse(res, { ...base, choices: [{ index: 0, delta: { content: "⚠ codex-shim compaction failed: " + String(e).slice(0, 200) } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
    } finally { clearInterval(ka); res.close(); }
  } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
}

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
  const legacyFingerprint = sha1(sys + "|" + legacyToolsHash(tools));
  const allToolNames = (tools || []).map(t => t.function?.name);
  const toolNames = stableToolNames(tools); // fingerprint/diff basis — volatile tools excluded
  const knownVolatile = rememberVolatileTools(tools);
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
  log(`[req] model=${model} key=${key ? key.slice(0, 12) : "-"}(${keySrc}) msgs=${messages.length} blocks=${blocks.length} tools=${tools ? tools.length : 0} tc=${typeof body.tool_choice === "string" ? body.tool_choice : body.tool_choice?.type ?? "-"} site=${req.headers.get("x-call-site") || "-"}`);
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

  // --- Vellum's compaction (summary) call: never a normal turn. Marked by X-Call-Site (local
  // retry.ts patch) or recognisable by tool_choice=none + the <compaction_instructions> block.
  const callSite = req.headers.get("x-call-site") || null;
  const lastUserBlock = [...blocks].reverse().find(b => b.kind === "user") || null;
  const toolChoice = typeof body.tool_choice === "string" ? body.tool_choice : body.tool_choice?.type;
  // X-Call-Site arrives as "mainAgent" even here (COMPACTION_CALL_SITE=mainAgent in compactor.ts) and tool_choice is
  // omitted for some models (gpt-6.1-sol) — the instruction block opening the trailing user message is the marker.
  if (isCompactionRequest(req, body)) {
    log(`[compact] detected operation=${req.headers.get("x-shim-operation") || "instruction"} site=${callSite || "-"} tool_choice=${toolChoice ?? "-"}`);
    return handleCompaction({ req, key, model, blocks, lastUserBlock, effort, id });
  }

  const oneUse = ONEUSE_RE.test(key);
  let state = oneUse ? (oneUseStates.get(key) ?? null) : key ? loadState(key) : null;
  // One-time migration: sessions fingerprinted before volatile tools were excluded. Match on the
  // legacy hash and re-key silently instead of invalidating every live chat after this deploy.
  if (state && state.model === model && state.fingerprint !== fingerprint && state.fingerprint === legacyFingerprint) {
    log(`[fp] migrated legacy fingerprint key=${key.slice(0, 12)} ${String(state.fingerprint).slice(0, 8)} -> ${fingerprint.slice(0, 8)}`);
    state.fingerprint = fingerprint; state.toolNames = toolNames; persistState(key, state);
  }
  let prevState = null, invalidReason = null;
  if (state && (state.model !== model || state.fingerprint !== fingerprint)) {
    prevState = state;
    invalidReason = [
      state.model !== model ? `model ${state.model} -> ${model}` : null,
      state.fingerprint !== fingerprint ? `fingerprint ${String(state.fingerprint).slice(0, 8)} -> ${fingerprint.slice(0, 8)}` : null,
    ].filter(Boolean).join("; ");
    state = null;
  }

  // blocks the thread hasn't seen yet. Unseen blocks positioned BEFORE the last seen block are
  // not new input — Vellum rewrote old history (reload after idle, compaction summary, /clean,
  // memory re-injection). The thread already saw the originals, so feeding them again would
  // duplicate history inside the model's context (Oct 4: 36 blocks / 59K chars re-fed). They
  // are skipped (and marked seen below); only the tail after the last seen block is fed.
  // Exception: a tool result for a call this thread still has parked is always delivered.
  let toFeed = blocks, skipped = [];
  if (state) {
    const seen = new Set(state.sent);
    const hashes = blocks.map(blockHash);
    let lastSeen = -1;
    for (let i = 0; i < blocks.length; i++) if (seen.has(hashes[i])) lastSeen = i;
    // A block whose hash changed but whose last 200 chars match a block this thread already
    // received is the same block with rewritten injections (Vellum strips <memory>/<channel_
    // capabilities>/... from the kept tail on compaction) — count it as seen wherever it sits.
    const tailIndex = new Map();
    for (const [h, m] of Object.entries(state.meta || {})) if (m && m.len >= 300 && m.tail) tailIndex.set(m.tail, h);
    const seenNow = blocks.map((b, i) => seen.has(hashes[i]) || (b.text.length >= 300 && tailIndex.has(b.text.slice(-200))));
    lastSeen = -1; for (let i = 0; i < blocks.length; i++) if (seenNow[i]) lastSeen = i;
    toFeed = []; const skippedIdx = []; let tailMatched = 0;
    blocks.forEach((b, i) => {
      if (seen.has(hashes[i])) return;
      const parkedTool = b.kind === "tool" && state.parked && state.parked[b.id];
      if (parkedTool) { toFeed.push(b); return; }
      if (seenNow[i]) { tailMatched++; skipped.push(b); skippedIdx.push(i); return; }
      if (i < lastSeen) { skipped.push(b); skippedIdx.push(i); } else toFeed.push(b);
    });
    if (tailMatched) log(`[guard] ${tailMatched} rewritten block(s) re-identified by tail match key=${key.slice(0, 12)}`);
    if (skipped.length) {
      log(`[guard] HISTORY-EDIT key=${key.slice(0, 12)} ${skipped.length} unseen block(s) before last seen #${lastSeen} (~${skipped.reduce((n, b) => n + b.text.length, 0)} chars) — rewritten history, NOT fed; tail=${toFeed.length}`);
      dumpHistoryEdit(key.slice(0, 12), { key: key.slice(0, 12), thread: state.threadId, model: state.model }, blocks, hashes, skippedIdx, lastSeen, state.sent || [], state.meta || {});
    }
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
  const prompt = promptForSession(messages, userBlocks.map(b => b.text).join("\n\n"), !state);
  if (!state) log(`[history] ${key.slice(0, 12)} fresh rehydration messages=${messages.length} chars=${prompt.length} summary=${messages.some(m => m.role === "assistant" && JSON.stringify(m.content ?? "").includes("<context_summary>"))}`);

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
          if (prevState) notice("Сессия заменена", [prevState.model !== model ? `${prevState.model} → ${model}` : null, prevState.fingerprint !== fingerprint ? fpDiff(prevState, sys, toolNames, key) : null].filter(Boolean).join("; "));
          const toDyn = t => ({ type: "function", name: t.function.name,
            description: t.function.description || "", inputSchema: t.function.parameters || { type: "object" } });
          // offer every volatile tool ever seen, not just this request's — the thread can't gain tools later
          const extraVolatile = Object.values(knownVolatile).filter(t => t?.function?.name && !allToolNames.includes(t.function.name));
          const dynTools = [...(tools || []), ...extraVolatile].map(toDyn);
          if (extraVolatile.length) log(`[tools] offering ${extraVolatile.length} volatile tool(s) absent from this request: ${extraVolatile.map(t => t.function.name).join(",")}`);
          const r = await srv.request("thread/start", {
            model, cwd: WORKDIR, approvalPolicy: "never", sandbox: SANDBOX,
            baseInstructions: sys || undefined,
            // Disable codex's INVISIBLE native tools: shell/unified_exec run inside
            // app-server (we see nothing, only the rollout file shows them) and
            // multi_agent spawns sub-agents silently. With them off the model uses the
            // caller's dynamic tools (Vellum `bash` etc.) which we park + log.
            // SHIM_NATIVE_TOOLS=1 re-enables them.
            config: { include_permissions_instructions: false, model_reasoning_summary: "detailed", show_raw_agent_reasoning: true,
              ...(process.env.SHIM_NATIVE_TOOLS ? {} : { features: { shell_tool: false, unified_exec: false, multi_agent: false, plugins: false, apps: false } }) },
            dynamicTools: dynTools.length ? dynTools : undefined,
            ephemeral: key ? undefined : true,
          });
          const threadId = r.thread.id;
          liveThreads.add(threadId);
          if (!oneUse) threadOwners.set(threadId, {key, model});
          notice("Старт", `${model}; с нуля`);
          state = { threadId, sent: [], model, fingerprint, parked: {}, sys, toolNames };
          persistState(key, state);
          log("[guard] thread started:", threadId, "model:", model);
        } else if (!liveThreads.has(state.threadId)) {
          // thread not loaded in this app-server process (we restarted) — reload from disk
          log(`[guard] RESUME thread=${state.threadId} key=${key.slice(0, 12)} alreadyFed=${(state.sent || []).length} new=${feedCount} (${userBlocks.length} user + ${toolResults.length} tool) parked=${Object.keys(state.parked || {}).length}`);

          try {
            await srv.request("thread/resume", { threadId: state.threadId, excludeTurns: true, config: { include_permissions_instructions: false } });
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
        if (compactLocks.has(state.threadId)) { await awaitCompactLock(state.threadId, key.slice(0, 12)); const fresh = loadState(key); if (fresh?.pendingCompactNotice) state.pendingCompactNotice = fresh.pendingCompactNotice; }
        if (state.pendingCompactNotice) { notice("Компакция", state.pendingCompactNotice); delete state.pendingCompactNotice; persistState(key, state); }
        else if (skipped.length) notice("Не отправлено", `${model}; ${skipped.length} старых блоков (~${Math.round(skipped.reduce((n, b) => n + b.text.length, 0) / 1000)}K симв.): история переписана, тред видел исходники`);
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
              if (isVolatileTool(m.params.tool) && !allToolNames.includes(m.params.tool)) {
                // tool exists in the thread but not for the client currently connected — don't park
                // (Vellum would reject an unknown tool call); tell the model and let the turn continue
                log(`[tool] ${m.params.tool} unavailable for the current client — error returned, not parked`);
                return { contentItems: [{ type: "inputText", text: `Tool ${m.params.tool} is not available right now: the user's current device/client does not support it. Continue without it (for example, ask the user in plain text).` }], success: false };
              }
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
        state.meta = Object.fromEntries(blocks.map(b => [blockHash(b), blockMeta(b)])); // per-block len/head/tail for history-edit forensics
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
