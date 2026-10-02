// claude-shim v3 — fork of server.js (Sep 30) with the SDK features found in the VS Code extension:
// verbatimPrompts, fallbackModel, maxBudgetUsd, flag settings (precompute compaction), live effort
// switch via applyFlagSettings, getContextUsage + rate_limit_event in the usage chunk, json_schema
// output for one-shots, actual-model reporting. See scratch/claude-vscode-ext-architecture.md.
// OpenAI-compatible chat completions shim backed by Claude Code (Agent SDK + OAuth token).
// Listens on 127.0.0.1:8317. Endpoints: POST /v1/chat/completions (SSE), GET /v1/models.
//
// Tool calling: OpenAI `tools` are rendered into the prompt as a text contract.
// The model emits `TOOL_CALL: {"name": ..., "arguments": {...}}` lines; we parse them
// and return real OpenAI `tool_calls` deltas. Tool execution stays on the Vellum side.
// Claude Code's own SDK tools (Bash/Read/...) remain disabled on purpose.
import { createSdkMcpServer, tool, query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { z } from "zod";
const TOOL_MODE = process.env.SHIM_TOOL_MODE || "mcp"; // mcp | text
const BATCH_IDLE_MS = Number(process.env.SHIM_BATCH_IDLE_MS || 5000);
const TOOL_WAIT_MS = Number(process.env.SHIM_TOOL_WAIT_SEC || 3600) * 1000; // how long a tool_use may wait for Vellum's result (approvals)
const FULL_HIST_MIN = Number(process.env.SHIM_FULL_HIST_MIN || 8); // feeding >= this many unseen blocks = full-history re-feed, warn in chat
// Red-ish in-chat notices from the shim. Markdown has no colour; format is picked by SHIM_NOTICE_FMT: html | font | diff | md
const NOTICE_FMT = process.env.SHIM_NOTICE_FMT || "diff";
function fmtNotice(body) {
  if (NOTICE_FMT === "font") return `<font color="red">${body}</font>\n\n`;
  if (NOTICE_FMT === "diff") return "```diff\n" + body.split("\n").map((l) => "- " + l).join("\n") + "\n```\n";
  if (NOTICE_FMT === "md") return `> 🔴 **${body}**\n\n`;
  return `<span style="color:red">${body}</span>\n\n`;
}
function shimNotice(onMsg, tag, text) {
  console.log(`[notice ${tag}] ${text}`);
  onMsg({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: fmtNotice(`[shim] ${text}`) } } });
}
const PORT = Number(process.env.SHIM_PORT || 8317);

const MAX_LIVE = Number(process.env.SHIM_MAX_LIVE || process.env.SHIM_POOL_SIZE || 8);
const IDLE_TTL_MS = Number(process.env.SHIM_IDLE_TTL_SEC || 3600) * 1000;
const SESS_DIR = process.env.SHIM_SESSIONS_DIR || `${import.meta.dir}/sessions`;
// One-shot requests (first message of a conversation: no assistant/tool turns yet) get a
// throwaway process that is closed right after the answer. They do not occupy chat slots;
// SHIM_MAX_ONESHOT is a separate OOM guard (~220 MB per process). 0 = unlimited.
const MAX_ONESHOT = Number(process.env.SHIM_MAX_ONESHOT ?? 32);
// router-oneuse-<uuid> keys come from shim-router for Vellum internal call sites:
// one logical task per key. The CLI is killed right after its turn completes, is
// never parked to disk, never counted against MAX_LIVE, and is listed separately
// from real chats in /chats. SHIM_MAX_ONEUSE is the OOM guard for tool-bearing
// one-use chats (tool-less ones go through runEphemeral like any one-shot).
const ONEUSE_RE = /^router-oneuse-/;
const MAX_ONEUSE = Number(process.env.SHIM_MAX_ONEUSE ?? 16);
const ONEUSE_IDLE_MS = Number(process.env.SHIM_ONEUSE_IDLE_MS ?? 15 * 60e3);
const DEFAULT_MODEL = "sonnet";
const SHIM_VERSION = "v3";
const FALLBACK_MODEL = process.env.SHIM_FALLBACK_MODEL ?? "sonnet";   // "" disables; applied when it differs from the requested model
const VERBATIM = process.env.SHIM_VERBATIM !== "0";                  // client_composed prompts: no @path/slash expansion, no CLAUDE.md / skill listings attached
const CTX_USAGE = process.env.SHIM_CONTEXT_USAGE !== "0";            // ask the CLI for get_context_usage after each turn
const PRECOMPUTE_COMPACT = process.env.SHIM_PRECOMPUTE_COMPACT !== "0"; // flag settings: compaction summary precomputed in the background
const SYS_SNAPSHOT = process.env.SHIM_SYS_SNAPSHOT === "1";           // record the system prompt in the transcript; a changed prompt then starts a fresh session
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
  constructor(label, model, resume = null, systemPrompt = null, effort = null, mcp = null, extra = {}) {
    this.id = ++cliSeq;
    this.effort = effort ?? null;
    this.actualModel = null;
    this.extra = extra;
    this.toolNames = mcp?.names ?? [];
    this.toolSig = mcp?.sig ?? null;
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
        ...(systemPrompt ? { systemPrompt: { type: "custom", prompt: systemPrompt, snapshot: SYS_SNAPSHOT } } : {}),
        verbatimPrompts: VERBATIM,
        ...(FALLBACK_MODEL && FALLBACK_MODEL !== model ? { fallbackModel: FALLBACK_MODEL } : {}),
        ...(extra.maxBudgetUsd ? { maxBudgetUsd: extra.maxBudgetUsd } : {}),
        ...(extra.outputFormat ? { outputFormat: extra.outputFormat } : {}),
        ...(PRECOMPUTE_COMPACT ? { settings: { autoCompactEnabled: true, precomputeCompactionEnabled: true } } : {}),
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
        tools: [],
        ...(mcp ? { mcpServers: { vellum: mcp.make() }, allowedTools: mcp.names.map((n) => `mcp__vellum__${n}`) } : { allowedTools: [] }),
        permissionMode: "bypassPermissions",
        settingSources: [],
        includePartialMessages: true,
        // Thinking: adaptive by default; display:"summarized" is REQUIRED — without it
        // subscription traffic gets redacted blocks (empty text + signature, only
        // estimated_tokens). Summaries stream as thinking_delta → reasoning_content.
        // reasoning_effort "none" disables thinking; supported effort tiers pass to the CLI.
        ...(effort === "none"
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "adaptive", display: "summarized" },
              ...(effort ? { effort } : {}) }),
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
        if (TOOL_MODE === "mcp" && msg.type === "assistant" && (msg.message?.content || []).some((b) => b.type === "tool_use")) {
          // Always remember tool_use batches until an observer has seen them.
          (this.unobserved ||= []).push(msg);
        }
        if (msg.type === "system" && msg.subtype === "init") {
          this.sessionId = msg.session_id;
          const mcpTools = (msg.tools || []).filter((t) => String(t).startsWith("mcp__"));
          const servers = (msg.mcp_servers || []).map((x) => `${x.name}:${x.status}`).join(",");
          console.log(`[cli${this.id} ${this.label}] init tools=${mcpTools.length} mcp=[${servers}] expected=${this.toolNames.length}`);
        }
        if (msg.type === "result" && msg.session_id) this.sessionId = msg.session_id;
        if (msg.type === "assistant" && msg.message?.model && msg.message.model !== this.actualModel) { this.actualModel = msg.message.model; console.log(`[cli${this.id} ${this.label}] serving model=${this.actualModel}`); }
        if (msg.type === "rate_limit_event") manager.noteRateLimit(msg.rate_limit_info);
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

  // Re-attach an observer to a send that is still in flight (mcp mode: the turn
  // that emitted tool_use is still running while Vellum executed the tools).
  attach(onMsg) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("cli closed"));
      if (!this.done) return reject(new Error("no run in flight"));
      const prev = this.done;
      this.done = { resolve: (r) => { prev.resolve(r); resolve(r); }, reject: (e) => { prev.reject(e); reject(e); } };
      this.onMsg = onMsg;
      // tool_use batches that arrived while no request was attached
      let replay = this.unobserved || []; this.unobserved = [];
      if (!replay.length && (this.lastBatch || []).some((m) => (m.message?.content || []).some((b) => b.type === "tool_use" && pendingToolUses.has(b.id)))) { replay = this.lastBatch; console.log(`[cli${this.id} ${this.label}] re-emitting unanswered tool batch to the new request`); }
      for (const m of replay) onMsg(m);
    });
  }
  markObserved() { if (this.unobserved?.length) this.lastBatch = this.unobserved; this.unobserved = []; }

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

  // Live effort change through the flag-settings layer (what the VS Code host does). Returns false
  // when a respawn is needed (thinking on<->off, or no explicit effort to apply).
  async setEffort(effort) {
    const cur = this.effort ?? null, nxt = effort ?? null;
    if (cur === nxt) return true;
    if (cur === "none" || nxt === "none" || nxt === null) return false;
    const lvl = nxt;
    try { await this.q.applyFlagSettings({ effortLevel: lvl }); this.effort = nxt; console.log(`[cli${this.id} ${this.label}] effort ${cur} -> ${lvl} (live)`); return true; }
    catch (e) { console.log(`[cli${this.id} ${this.label}] live effort change failed: ${String(e?.message || e).slice(0, 100)}`); return false; }
  }

  async contextUsage() {
    if (!this.alive) return null;
    try { return await this.q.getContextUsage({ detail: "summary" }); } catch (e) { console.log(`[cli${this.id}] get_context_usage failed: ${String(e?.message || e).slice(0, 80)}`); return null; }
  }

  // Swap the Vellum tool set on a live session (skills load/unload between turns).
  async setTools(mcp) {
    const names = mcp?.names ?? [];
    if ((mcp?.sig ?? null) === (this.toolSig ?? null)) return;
    this.toolSig = mcp?.sig ?? null;
    const r = await this.q.setMcpServers(mcp ? { vellum: mcp.make() } : {});
    this.toolNames = names;
    console.log(`[cli${this.id} ${this.label}] tools swapped -> ${names.length} (${JSON.stringify(r).slice(0, 80)})`);
  }
}
function sameList(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

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
    this.oneUse = false;
    this.lock = Promise.resolve();
  }
  get live() { return !!this.cli?.alive; }
  file() { return `${SESS_DIR}/${sha(this.key)}.json`; }
  save() {
    if (this.oneUse) return; // one-use chats are never persisted
    try {
      writeFileSync(this.file(), JSON.stringify({ key: this.key, sessionId: this.sessionId, model: this.model, sent: this.sent, sysHash: this.sysHash, effort: this.effort, lastUsed: this.lastUsed, served: this.served, savedAt: Date.now() }));
    } catch (e) { console.error(`[sess] save failed ${short(this.key)}: ${e.message}`); }
  }
  park(reason) {
    this.parkedWhy = reason;
    if (this.cli) {
      console.log(`[sess] ${short(this.key)} park (${reason}) cli${this.cli.id} session=${this.sessionId}`);
      this.cli.close(); this.cli = null;
    }
    if (!this.oneUse) this.save();
  }

  // Requests for one chat are serialised; Vellum sends full history each time.
  async run(model, blocks, onMsg, effort = null, mcp = null, extra = {}) {
    const prev = this.lock;
    let release; this.lock = new Promise((r) => (release = r));
    await prev;
    this.busy = true;
    let released = false;
    const rel = () => { if (released) return; released = true; this.busy = false; this.lastUsed = Date.now(); release(); manager.kick(); };
    extra.exposeRel?.(rel);
    if (extra.signal?.aborted) { rel(); throw new Error("client went away while queued"); }
    this.releaseForTools = rel; // mcp mode: request layer releases once tool_calls are sent, so the follow-up can enter
    try { return await this._run(model, blocks, onMsg, effort, mcp, extra); }
    finally { rel(); if (this.oneUse) setTimeout(() => manager.maybeDestroyOneUse(this.key), 500); }
  }

  // No resets. The CLI transcript is the source of truth; Vellum's history is
  // only used to find what the CLI has not seen yet. Every input block whose
  // hash is unknown to this chat is fed, in order. Compaction (summary replaces
  // the head) therefore sends just the summary; a retried identical history
  // re-sends the last user block. A fresh process is spawned only when there is
  // no live one, with `resume` when a session id exists.
  async _run(model, blocks, onMsg, effort = null, mcp = null, extra = {}) {
    const inputs = inputBlocks(blocks);
    const hashes = inputs.map((b) => sha(b.text));
    const sys = systemText(blocks);
    const sysHash = sys ? sha(sys) : null;
    if (sysHash !== this.sysHash) {
      if (this.live) this.park("system changed");
      // a recorded (snapshot) prompt is reused verbatim on resume, so a changed prompt needs a fresh session
      if (SYS_SNAPSHOT && this.sessionId) { console.log(`[sess] ${short(this.key)} system changed under snapshot -> fresh session`); this.sessionId = null; this.sent = []; }
    }
    if (this.live && !(await this.cli.setEffort(effort))) this.park("effort changed");
    const seen = new Set(this.sent);
    const prior = new Set(this.sent);
    let unseen = inputs.filter((_, i) => !seen.has(hashes[i]));
    // mcp mode: the tool results were handed to the CLI natively (resolveToolResults);
    // mark them seen and, if nothing else is new while a run is in flight, attach to that run.
    if (TOOL_MODE === "mcp") {
      unseen = unseen.filter((b) => b.role !== "tool" || !b.consumed);
      for (const h of hashes) if (!seen.has(h)) seen.add(h);
      if (!unseen.length && this.cli?.done) {
        console.log(`[sess] ${short(this.key)} continuing in-flight run (tool results delivered)`);
        const res = await this.cli.attach(onMsg);
        this.sent = [...seen]; this.sessionId = res.session_id || this.cli.sessionId; this.served++; this.lastUsed = Date.now(); this.save();
        console.log(`[sess] ${short(this.key)} served #${this.served} model=${model} (continued) in=${res.usage?.input_tokens ?? "?"} cache_read=${res.usage?.cache_read_input_tokens ?? "?"} session=${this.sessionId}`);
        return res;
      }
    }
    let why = !this.sent.length ? "new" : unseen.length ? `tail=${unseen.length}` : "repeat";
    if (!unseen.length) unseen = inputs.slice(-1);
    for (let attempt = 0; attempt < 2; attempt++) {
      let produced = false;
      const t0 = Date.now();
      try {
        if (!this.live) {
          this.cli = await manager.spawn(short(this.key), model, this.sessionId, sys, effort, mcp, { maxBudgetUsd: extra.maxBudgetUsd });
          why += this.sessionId ? " resume" : " spawn";
          this.sysHash = sysHash;
        }
        await this.cli.setModel(model);
        this.model = model;
        if (TOOL_MODE === "mcp") await this.cli.setTools(mcp);
        const prompt = unseen.map((b) => b.text).concat(["Assistant:"]).join("\n\n");
        console.log(`[sess] ${short(this.key)} cli${this.cli.id} ${why} blocks=${inputs.length} seen=${this.sent.length}`);
        const tPrep = Date.now() - t0;
        for (const h of hashes) seen.add(h);
        if (TOOL_MODE === "mcp") { this.sent = [...seen]; this.save(); }
        // emitted at the point of the actual send so any re-feed path is caught, foreseen or not
        const notes = [];
        if (why.startsWith("new")) notes.push(`new chat session on this shim: ${unseen.length} history blocks fed${unseen.length >= FULL_HIST_MIN ? " (model switch?)" : ""}`);
        else if (why.includes("resume")) notes.push(`resumed session ${String(this.sessionId).slice(0, 8)} after ${this.parkedWhy ?? "restart"}: tail of ${unseen.length} new blocks`);
        // anomaly = unseen blocks positioned BEFORE the last block this chat has already seen (history rewritten / re-fed), or nothing matches at all
        let lastSeenIdx = -1; for (let i = 0; i < hashes.length; i++) if (prior.has(hashes[i])) lastSeenIdx = i;
        const refed = inputs.map((b, i) => i).filter((i) => !prior.has(hashes[i]) && i < lastSeenIdx && !(inputs[i].role === "tool" && inputs[i].consumed));
        if (refed.length) notes.push(`WARNING: ${refed.length} block(s) from already-seen history re-fed (positions ${refed.slice(0, 6).join(",")}${refed.length > 6 ? ",…" : ""}; last seen block at ${lastSeenIdx}/${inputs.length})`);
        else if (prior.size && lastSeenIdx < 0) notes.push(`WARNING: none of ${inputs.length} blocks match this chat's ${prior.size} known blocks — full history re-feed`);
        if (notes.length) shimNotice(onMsg, short(this.key), notes.join("\n"));
        const res = await this.cli.send(prompt, (m) => { produced = true; onMsg(m); });
        this.sent = [...seen]; this.sessionId = res.session_id || this.cli.sessionId; this.model = model; this.effort = effort ?? null; this.served++; this.lastUsed = Date.now();
        res.shim_actual_model = this.cli?.actualModel ?? null;
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
  oneuse: new Map(),
  oneuseWaiters: [],
  ephemeral: new Set(),
  reserved: 0,
  waiters: [],
  liveCount() {
    let n = this.reserved;
    for (const c of this.chats.values()) if (c.live) n++;
    return n;
  },
  liveOneUse() { let n = 0; for (const c of this.oneuse.values()) if (c.live) n++; return n; },
  async getOneUse(key) {
    let c = this.oneuse.get(key);
    if (!c) { c = new Chat(key, null); c.oneUse = true; this.oneuse.set(key, c); }
    // OOM guard: a new process waits when too many one-use CLIs are live; a
    // continuation of an already-live chat passes (it spawns nothing).
    while (!c.live && this.liveOneUse() >= MAX_ONEUSE) await new Promise((r) => this.oneuseWaiters.push(r));
    return c;
  },
  maybeDestroyOneUse(key) {
    const c = this.oneuse.get(key);
    if (!c || c.busy) return;
    for (const p of pendingToolUses.values()) if (p.chatKey === key) return; // tool round trip still in flight
    console.log(`[sess] ${short(key)} oneuse turn done — cli closed, nothing persisted`);
    if (c.cli) { c.cli.close(); c.cli = null; }
    this.oneuse.delete(key);
    const w = this.oneuseWaiters.shift(); if (w) w();
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
  async spawn(label, model, resume, systemPrompt = null, effort = null, mcp = null, extra = {}) {
    while (this.liveCount() >= MAX_LIVE) {
      const idle = [...this.chats.values()].filter((c) => c.live && !c.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length) { idle[0].park("evict"); continue; }
      await new Promise((r) => this.waiters.push(r));
    }
    this.reserved++;
    try { return new Cli(label, model, resume, systemPrompt, effort, mcp, extra); } finally { this.reserved--; }
  },
  kick() { const w = this.waiters.splice(0); for (const r of w) r(); },
  reap() {
    const now = Date.now();
    for (const c of this.oneuse.values()) {
      if (!c.busy && now - c.lastUsed > ONEUSE_IDLE_MS) {
        console.log(`[sess] ${short(c.key)} oneuse idle reaped`);
        if (c.cli) { c.cli.close(); c.cli = null; }
        this.oneuse.delete(c.key);
        const w = this.oneuseWaiters.shift(); if (w) w();
      }
    }
    for (const c of this.chats.values()) {
      if (c.live && !c.busy && now - c.lastUsed > IDLE_TTL_MS) c.park("idle");
      else if (!c.live && !c.busy && now - c.lastUsed > 24 * 3600e3) this.chats.delete(c.key); // disk copy stays
    }
  },
  oneshotWaiters: [],
  async runEphemeral(model, blocks, onMsg, tag = "nokey", attempts = 3, effort = null, mcp = null, extra = {}) {
    while (MAX_ONESHOT > 0 && this.ephemeral.size >= MAX_ONESHOT) await new Promise((r) => this.oneshotWaiters.push(r));
    let lastErr;
    for (let a = 0; a < attempts; a++) {
      const cli = new Cli(tag, model, null, systemText(blocks), effort, mcp, extra);
      this.ephemeral.add(cli);
      let produced = false;
      try {
        const t0 = Date.now();
        const ib = inputBlocks(blocks);
        if (ib.length >= FULL_HIST_MIN) shimNotice(onMsg, tag, `WARNING: ${ib.length} history blocks fed to a one-shot process (${tag}) — no live chat session`);
        const res = await cli.send(blocksToPrompt(ib), (m) => { produced = true; onMsg(m); });
        res.shim_actual_model = cli.actualModel;
        if (CTX_USAGE) res.shim_context_usage = await cli.contextUsage();
        console.log(`[${tag}] cli${cli.id} model=${model} actual=${cli.actualModel ?? "?"} total=${Date.now() - t0}ms in=${res.usage?.input_tokens ?? "?"} cache_read=${res.usage?.cache_read_input_tokens ?? "?"}`);
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
  run(model, key, blocks, onMsg, effort = null, mcp = null, extra = {}) {
    if (!key) return this.runEphemeral(model, blocks, onMsg, "nokey", 3, effort, mcp, extra);
    if (ONEUSE_RE.test(key)) {
      // No tools -> throwaway process, killed in runEphemeral's finally. With tools the
      // handler must outlive this HTTP response, so a transient Chat survives until the
      // turn ends (maybeDestroyOneUse) and is then closed, never parked, never pooled.
      if (!mcp) return this.runEphemeral(model, blocks, onMsg, `oneuse ${short(key)}`, 3, effort, mcp, extra);
      return this.getOneUse(key).then((c) => c.run(model, blocks, onMsg, effort, mcp, extra));
    }
    if (!this.chats.has(key) && this.isOneShot(blocks) && !mcp) return this.runEphemeral(model, blocks, onMsg, `oneshot ${short(key)}`, 3, effort, mcp, extra);
    return this.get(key).run(model, blocks, onMsg, effort, mcp, extra);
  },
  rateLimits: null,
  noteRateLimit(info) {
    if (!info) return;
    const sig = JSON.stringify(info);
    if (sig === this.rateLimits?.sig) return;
    this.rateLimits = { at: Date.now(), sig, info };
    const w = info.unifiedWindows || info;
    const fmt = (x) => x && x.utilization != null ? `${Math.round(x.utilization * 100)}%${x.resets_at ? " resets " + x.resets_at : ""}` : "-";
    console.log(`[ratelimit] status=${info.status ?? "?"} 5h=${fmt(w.five_hour)} 7d=${fmt(w.seven_day)}`);
  },
  async contextUsage(key) {
    if (!CTX_USAGE || !key) return null;
    const c = this.chats.get(key);
    return c?.cli?.alive ? c.cli.contextUsage() : null;
  },
  status() {
    return {
      version: SHIM_VERSION, verbatim: VERBATIM, fallbackModel: FALLBACK_MODEL || null, rateLimits: this.rateLimits?.info ?? null, maxLive: MAX_LIVE, maxOneshot: MAX_ONESHOT, idleTtlSec: IDLE_TTL_MS / 1000, live: this.liveCount(), oneshot: [...this.ephemeral].map((c) => ({ cli: c.id, label: c.label, model: c.model })), waiters: this.waiters.length, oneshotWaiters: this.oneshotWaiters.length,
      maxOneuse: MAX_ONEUSE,
      oneuseChats: [...this.oneuse.values()].map((c) => ({ key: short(c.key), live: c.live, busy: c.busy, cli: c.cli?.id ?? null, model: c.model, served: c.served, idleSec: Math.round((Date.now() - c.lastUsed) / 1000) })),
      chats: [...this.chats.values()].map((c) => ({ key: short(c.key), live: c.live, busy: c.busy, cli: c.cli?.id ?? null, model: c.model, actual: c.cli?.actualModel ?? null, served: c.served, sent: c.sent.length, session: c.sessionId, idleSec: Math.round((Date.now() - c.lastUsed) / 1000) })),
    };
  },
};
setInterval(() => manager.reap(), 60_000);
process.on("SIGTERM", () => { for (const c of manager.chats.values()) c.park("shutdown"); for (const c of manager.oneuse.values()) { if (c.cli) c.cli.close(); } process.exit(0); });

// ---------------------------------------------------------------------------
// MCP tool mode. Vellum's tools are registered on the CLI as an in-process MCP
// server, so the model emits native tool_use (the API owns JSON escaping) and
// nothing is parsed out of prose. Handlers do NOT execute anything: the tool
// call is forwarded to Vellum as OpenAI `tool_calls`, and the handler waits
// until Vellum's next request carries the `role: tool` result for that id.
// Approvals, trust rules and execution stay inside Vellum, exactly as before.

// tool_use id -> { resolve, reject, timer, name, chatKey }
const pendingToolUses = new Map();
const consumedToolIds = new Set(); // ids whose result reached the CLI as a native tool_result

function jsonSchemaToZod(schema) {
  const t = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  let z_;
  if (schema?.enum && Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string") && schema.enum.length) {
    z_ = z.enum(schema.enum);
  } else if (schema?.anyOf || schema?.oneOf) {
    const opts = (schema.anyOf || schema.oneOf).map(jsonSchemaToZod);
    z_ = opts.length > 1 ? z.union(opts) : opts[0] ?? z.unknown();
  } else if (t === "string") z_ = z.string();
  else if (t === "number") z_ = z.number();
  else if (t === "integer") z_ = z.number().int();
  else if (t === "boolean") z_ = z.boolean();
  else if (t === "null") z_ = z.null();
  else if (t === "array") z_ = z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown());
  else if (t === "object" || schema?.properties) {
    const props = schema.properties || {};
    const req = new Set(schema.required || []);
    const shape = {};
    for (const [k, v] of Object.entries(props)) shape[k] = req.has(k) ? jsonSchemaToZod(v) : jsonSchemaToZod(v).optional();
    z_ = z.looseObject(shape); // never z.record: the SDK's bundled json-schema converter throws on it (ctx.deferred) and the CLI ends up with 0 tools
  } else z_ = z.unknown();
  if (schema?.description) z_ = z_.describe(schema.description);
  return z_;
}

// Top-level params must be a zod *shape* (raw object of fields), not a z.object.
function paramsToShape(parameters) {
  const props = parameters?.properties || {};
  const req = new Set(parameters?.required || []);
  const shape = {};
  for (const [k, v] of Object.entries(props)) {
    let f;
    try { f = jsonSchemaToZod(v); } catch { f = z.unknown(); }
    shape[k] = req.has(k) ? f : f.optional();
  }
  return shape;
}

// An SDK MCP server instance is bound to the CLI process it is handed to, so
// never share one across processes: `buildMcp` returns a spec { defs, names, sig }
// and each Cli materialises its own server via `mcp.make()`.
const shapeCache = new Map(); // tool signature -> zod shape
// The SDK converts zod shapes to JSON schema with its own bundled zod core; some constructs from
// the external zod copy blow up there, and ONE bad tool empties the whole tools/list (CLI then
// runs with 0 tools while reporting the server "connected"). Validate each shape up front.
async function shapeConvertible(name, shape) {
  try {
    const srv = createSdkMcpServer({ name: "probe", tools: [tool(name, name, shape, async () => ({ content: [] }))] });
    const h = srv.instance?.server?._requestHandlers?.get("tools/list");
    if (!h) return true;
    const r = await h({ method: "tools/list", params: {} }, { signal: new AbortController().signal });
    return Array.isArray(r?.tools) && r.tools.length === 1;
  } catch { return false; }
}
async function shapeFor(t) {
  const name = t.function.name;
  const k = sha(name + JSON.stringify(t.function.parameters || {}));
  let shape = shapeCache.get(k);
  if (shape) return shape;
  try { shape = paramsToShape(t.function.parameters); } catch (e) { console.log(`[mcp] schema for ${name} fell back to open object: ${e.message}`); shape = {}; }
  if (!(await shapeConvertible(name, shape))) { console.log(`[mcp] schema for ${name} not convertible by SDK, using open object`); shape = {}; }
  if (shapeCache.size > 512) shapeCache.delete(shapeCache.keys().next().value);
  shapeCache.set(k, shape);
  return shape;
}
async function buildMcp(tools, chatKey) {
  const defs = (tools || []).filter((t) => t?.type === "function" && t.function?.name);
  if (!defs.length) return null;
  const sig = sha(JSON.stringify(defs.map((t) => [t.function.name, t.function.description, t.function.parameters])));
  const names = defs.map((t) => t.function.name);
  const shapes = new Map();
  for (const t of defs) shapes.set(t.function.name, await shapeFor(t));
  const make = () => { const srv = createSdkMcpServer({ name: "vellum", tools: defs.map((t) => {
    const name = t.function.name;
    return tool(name, t.function.description || name, shapes.get(name), async (args, extra) => {
      const metaId = extra?._meta?.["claudecode/toolUseId"];
      const id = metaId || `${name}#${++provisionalSeq}`;
      return waitForVellum(name, id, args, extra?.signal, chatKey, !!metaId);
    });
  }) });
    if (process.env.SHIM_DEBUG_MCP) (async () => { try { const h = srv.instance?.server?._requestHandlers?.get("tools/list"); const r = await h({ method: "tools/list", params: {} }, { signal: new AbortController().signal }); console.log(`[mcp] debug in-process tools/list=${r.tools.length}`); } catch (e) { console.log(`[mcp] debug tools/list THROW ${e.message}`); } })();
    return srv; };
  return { make, names, sig };
}

// The handler parks here. The request layer observes the tool_use via the
// assistant stream event (it carries the real tool_use id) and forwards it to
// Vellum; the next request with a matching `role: tool` message resolves it.
let provisionalSeq = 0;
function rekeyPending(tu, chatKey) {
  if (pendingToolUses.has(tu.id)) return;
  tu = { ...tu, name: tu.name.replace(/^mcp__vellum__/, "") };
  // oldest provisional entry with the same name and equal args
  for (const [k, v] of pendingToolUses) {
    if (v.name === tu.name && !v.real && JSON.stringify(v.args ?? {}) === JSON.stringify(tu.input ?? {})) {
      pendingToolUses.delete(k); v.real = true; pendingToolUses.set(tu.id, v); return;
    }
  }
  for (const [k, v] of pendingToolUses) if (v.name === tu.name && !v.real) { pendingToolUses.delete(k); v.real = true; pendingToolUses.set(tu.id, v); return; }
}
// The CLI runs MCP handlers one at a time, but Vellum answers a whole batch at once:
// results for handlers that have not fired yet wait here, keyed by tool_use id.
const earlyResults = new Map();
const emittedToolIds = new Set(); // tool_use ids this process forwarded to Vellum
function waitForVellum(name, id, args, signal, chatKey, real = false) {
  const early = earlyResults.get(id);
  if (early) { earlyResults.delete(id); console.log(`[mcp] ${id} (${name}) served from early result`); return Promise.resolve(early); }
  return new Promise((resolve, reject) => {
    // real=true: registered under the CLI's own tool_use id — rekeyPending must never steal it for a sibling
    const entry = { name, args, resolve, reject, timer: null, at: Date.now(), chatKey: chatKey || null, real };
    entry.timer = setTimeout(() => {
      pendingToolUses.delete(id);
      console.log(`[mcp] tool_use ${id} (${name}) timed out after ${TOOL_WAIT_MS / 1000}s waiting for Vellum`);
      resolve({ content: [{ type: "text", text: `[shim] no result from Vellum within ${TOOL_WAIT_MS / 1000}s (request abandoned or approval never answered)` }], isError: true });
    }, TOOL_WAIT_MS);
    signal?.addEventListener?.("abort", () => {
      if (!pendingToolUses.has(id)) return;
      pendingToolUses.delete(id); clearTimeout(entry.timer);
      resolve({ content: [{ type: "text", text: "[shim] tool call aborted" }], isError: true });
    });
    pendingToolUses.set(id, entry);
  });
}

// Vellum echoes our ids back in `tool_call_id`. Match by id first; if the id
// is unknown (session parked/resumed in between), fall back to the oldest
// pending call with the same tool name.
// Only the request from the SAME chat (prompt_cache_key) may resolve a parked handler.
// The daemon's compactor re-sends the whole history WITHOUT a key; letting it resolve
// handlers un-parked the live run into nobody's response and hung the chat (Sep 30 16:00).
function resolveToolResults(messages, reqKey) {
  let n = 0;
  if (!reqKey) return 0;
  for (const m of messages || []) {
    if (m.role !== "tool") continue;
    const text = contentToText(m.content);
    let id = m.tool_call_id;
    let entry = id ? pendingToolUses.get(id) : null;
    if (entry && entry.chatKey && entry.chatKey !== reqKey) { console.log(`[mcp] ${id} belongs to another chat, ignoring result from key=${reqKey.slice(0, 12)}`); continue; }
    if (!entry && m.name) {
      for (const [k, v] of pendingToolUses) if (v.name === m.name && (!v.chatKey || v.chatKey === reqKey)) { id = k; entry = v; break; }
    }
    const isError = /^\s*(error|\[error\]|denied|tool call (was )?(denied|rejected))/i.test(text);
    const result = { content: [{ type: "text", text: text || "(empty result)" }], ...(isError ? { isError: true } : {}) };
    if (!entry) {
      const tid = m.tool_call_id;
      if (tid && emittedToolIds.has(tid) && !consumedToolIds.has(tid)) {
        earlyResults.set(tid, result); consumedToolIds.add(tid); n++;
        if (earlyResults.size > 500) earlyResults.delete(earlyResults.keys().next().value);
      }
      continue;
    }
    pendingToolUses.delete(id); clearTimeout(entry.timer); consumedToolIds.add(id);
    if (consumedToolIds.size > 5000) consumedToolIds.delete(consumedToolIds.values().next().value);
    entry.resolve(result);
    n++;
  }
  return n;
}

const TOOL_INSTRUCTIONS = `You have access to the functions listed in <tools>. To call one or more of them,
output ONLY lines of the exact form (one per call, nothing else in the message):
TOOL_CALL: {"name": "<function name>", "arguments": {<json arguments>}}
Rules:
- Each TOOL_CALL must be a single line of valid JSON after the prefix.
- Do not wrap TOOL_CALL lines in markdown fences and do not add commentary around them.
- Call functions only when they are needed; otherwise answer normally in plain text.
- Never use <function_calls>/<invoke> XML or any other native tool-call format. Only TOOL_CALL lines.
- After your TOOL_CALL line(s), STOP. Do not write anything after them.
- Inside JSON strings every " and \\ must be escaped. If a shell command needs nested quotes, backslashes,
  regexes, heredocs or a python -c one-liner, do NOT inline it: first call file_write to save it as a script
  file (e.g. scratch/step.sh), then call bash with a short one-line command that runs that file.
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
  if (TOOL_MODE !== "mcp" && Array.isArray(tools) && tools.length) {
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
      if (TOOL_MODE !== "mcp") for (const tc of m.tool_calls || []) lines.push(`TOOL_CALL: ${tcToJson(tc)}`);
      blocks.push({ role, text: `Assistant: ${lines.join("\n")}` });
    } else if (role === "tool") {
      const label = m.name || m.tool_call_id || "tool";
      // mcp mode: a result whose tool_use is still pending was consumed by
      // resolveToolResults and lives in the CLI transcript as a real
      // tool_result. Only orphaned results (session restarted in between) are
      // rendered as text so the model still sees them.
      if (TOOL_MODE === "mcp" && m.tool_call_id && consumedToolIds.has(m.tool_call_id)) { blocks.push({ role, text: `<tool_result id="${m.tool_call_id}"/>`, consumed: true }); continue; }
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

// Scan a balanced JSON object starting at `text[start]` ('{'). String-aware,
// so braces inside strings do not count, and raw newlines inside strings
// (the model sometimes writes multi-line shell into a JSON string verbatim)
// do not end the scan. Returns end index (exclusive) or -1.
function scanJsonObject(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// JSON.parse with a fallback that escapes raw control characters found inside
// string literals (invalid JSON, but exactly what a model emits when it pastes
// a heredoc into "command": "...").
function parseLooseJson(src) {
  try { return JSON.parse(src); } catch (e0) {
    let out = "", inStr = false, esc = false;
    for (const ch of src) {
      if (inStr) {
        if (esc) { esc = false; out += ch; continue; }
        if (ch === "\\") { esc = true; out += ch; continue; }
        if (ch === '"') { inStr = false; out += ch; continue; }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        out += ch; continue;
      }
      if (ch === '"') inStr = true;
      out += ch;
    }
    const obj = JSON.parse(out);
    console.log("[warn] TOOL_CALL JSON had raw control chars in strings; repaired");
    return obj;
  }
}

// Last resort for a TOOL_CALL whose JSON never closes (the model lost track of
// quote escaping inside a long string). Recover {"name": ..., "arguments": {...}}
// by slicing argument values between top-level key markers taken from the
// tool's schema, then decoding each value leniently. Returns null if even the
// name cannot be read.
function salvageToolCall(chunk, tools) {
  const head = chunk.match(/^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*\{/);
  if (!head) return null;
  const name = head[1];
  const def = (tools || []).find((t) => (t.function?.name ?? t.name) === name);
  const props = def?.function?.parameters?.properties || {};
  const keys = Object.keys(props);
  let body = chunk.slice(head[0].length).replace(/\s*```\s*$/, "").replace(/\s+$/, "");
  body = body.replace(/\}\s*\}?\s*$/, ""); // drop closing braces if the model got that far
  const marks = [];
  for (const k of keys) {
    const re = new RegExp(`(^|,)\\s*"${k}"\\s*:\\s*`, "g");
    let m, first = null, last = null;
    while ((m = re.exec(body))) { const o = { key: k, start: m.index, vstart: m.index + m[0].length }; if (!first) first = o; last = o; }
    if (!first) continue;
    marks.push(first.start === 0 ? first : last); // first key sits at 0; later keys: last occurrence wins
  }
  if (!marks.length) return null;
  marks.sort((x, y) => x.start - y.start);
  const args = {};
  for (let i = 0; i < marks.length; i++) {
    let raw = body.slice(marks[i].vstart, i + 1 < marks.length ? marks[i + 1].start : body.length).trim();
    if (raw.startsWith('"')) {
      raw = raw.slice(1).replace(/"\s*$/, "");
      let v;
      try { v = JSON.parse('"' + raw.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/(^|[^\\])"/g, '$1\\"') + '"'); }
      catch { v = raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
      args[marks[i].key] = v;
    } else {
      try { args[marks[i].key] = JSON.parse(raw); } catch { args[marks[i].key] = raw; }
    }
  }
  console.log(`[warn] salvaged unterminated TOOL_CALL ${name} keys=${Object.keys(args).join(",")}`);
  return { name, arguments: args };
}

function parseToolCalls(text, tools = []) {
  const inv = parseInvoke(text, tools);
  if (inv) return inv;
  const calls = [];
  let restText = null;
  let pos = 0;
  while (true) {
    const at = text.indexOf("TOOL_CALL:", pos);
    if (at < 0) break;
    const brace = text.indexOf("{", at);
    if (brace < 0) break;
    const endIdx = scanJsonObject(text, brace);
    if (endIdx < 0) {
      console.log("[warn] unterminated TOOL_CALL JSON |", text.slice(at, at + 160).replace(/\n/g, "\\n"));
      const sv = salvageToolCall(text.slice(brace), tools);
      if (sv) { if (restText === null) restText = text.slice(0, at); calls.push(sv); }
      break;
    }
    if (restText === null) restText = text.slice(0, at);
    try {
      const obj = parseLooseJson(text.slice(brace, endIdx));
      if (obj && typeof obj.name === "string") calls.push({ name: obj.name, arguments: obj.arguments ?? {} });
      else console.log("[warn] TOOL_CALL without name |", text.slice(brace, brace + 120).replace(/\n/g, "\\n"));
    } catch (e) {
      console.log("[warn] unparsable TOOL_CALL:", String(e.message).slice(0, 80), "|", text.slice(brace, brace + 160).replace(/\n/g, "\\n"));
      const sv = salvageToolCall(text.slice(brace, endIdx), tools);
      if (sv) calls.push(sv);
    }
    pos = endIdx; // anything between calls (or after the last) is discarded
  }
  if (restText === null) restText = text;
  let fabricated = false;
  const fab = restText.search(/<tool_result\b/);
  if (fab >= 0) { fabricated = true; restText = restText.slice(0, fab); console.log("[warn] model fabricated <tool_result>; output truncated"); }
  restText = restText.split("\n").filter((l) => l.trim() !== "```").join("\n").trim();
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
          { id: "claude-fable", object: "model", created: 0, owned_by: "claude-code" },
          { id: "claude-haiku", object: "model", created: 0, owned_by: "claude-code" },
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
    // Effort: validate, never guess. Anything but the CLI's tiers (or "none" = thinking off) is a 400.
    const KNOWN_EFFORT = ["none", "low", "medium", "high", "xhigh", "max"];
    const effort = body.reasoning_effort ?? body.reasoning?.effort ?? null;
    if (effort !== null && !KNOWN_EFFORT.includes(effort)) {
      console.log(`[req] REJECTED: unsupported effort ${JSON.stringify(effort)} (allowed: ${KNOWN_EFFORT.join(",")})`);
      return Response.json({ error: { message: `claude-shim: effort ${JSON.stringify(effort)} is not supported; allowed: ${KNOWN_EFFORT.join(", ")}`, type: "invalid_request_error", code: "unsupported_effort" } }, { status: 400 });
    }
    console.log(`[req] model=${model} msgs=${(body.messages || []).length} tools=${tools.length} effort=${effort ?? "-"} key=${typeof body.prompt_cache_key === "string" ? body.prompt_cache_key.slice(0, 12) : "-"}`);
    const sdkModel = model.replace(/^claude-/, ""); // opus | sonnet | haiku | fable
    const maxBudgetUsd = Number(req.headers.get("x-shim-max-budget-usd") || body.max_budget_usd || 0) || null;
    const rf = body.response_format;
    const outputFormat = rf?.type === "json_schema" && rf.json_schema?.schema ? { type: "json_schema", schema: rf.json_schema.schema } : null; // honoured on one-shot processes only
    const ac = { aborted: false, rel: null, abort: null, onGone: null };
    req.signal?.addEventListener?.("abort", () => ac.abort?.());
    const extra = { maxBudgetUsd, outputFormat, signal: req.signal, exposeRel: (r) => { ac.rel = r; } };
    if (process.env.SHIM_DUMP_TOOLS && hasTools) { try { writeFileSync(process.env.SHIM_DUMP_TOOLS, JSON.stringify(tools)); } catch {} }
    const mcp = TOOL_MODE === "mcp" && hasTools ? await buildMcp(tools, body.prompt_cache_key) : null;
    const resolved = TOOL_MODE === "mcp" ? resolveToolResults(body.messages || [], typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? body.prompt_cache_key : null) : 0;
    if (resolved) console.log(`[mcp] resolved ${resolved} pending tool result(s)`);
    const blocks = messagesToBlocks(body.messages || [], tools);
    const cacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? body.prompt_cache_key : null;
    if (!cacheKey) { console.log(`[req] REJECTED: no prompt_cache_key (full history without a chat id)`); return Response.json({ error: { message: "claude-shim: prompt_cache_key (chat id) is required; keyless requests are rejected" } }, { status: 400 }); }
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);

    const stream = new ReadableStream({
      cancel() { ac.abort?.(); },
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const ka = setInterval(() => send(": keepalive\n\n"), 15000); // no idle gaps while the model thinks or writes tool args
        ac.abort = () => { if (ac.aborted || closed) return; ac.aborted = true; closed = true; console.log(`[req] client went away key=${cacheKey ? cacheKey.slice(0, 12) : "-"}; releasing chat`); ac.rel?.(); ac.onGone?.(); };
        const send = (s) => { if (closed) return; try { controller.enqueue(enc.encode(s)); } catch { closed = true; } };
        try {
          send(sseChunk(id, model, { role: "assistant" }));
          let buffer = "";
          let sawDelta = false;
          const mcpMode = TOOL_MODE === "mcp";
          const toolUses = [];      // native tool_use blocks seen this turn
          let turnDone = null;      // resolves when the assistant message carrying tool_use(s) is complete
          let batchTimer = null;    // fallback if message_stop never arrives
          let expectedTus = 0, msgStopped = false, batchWhy = "";   // content_block_start(tool_use) count vs collected assistant tool_use blocks
          const closeBatch = (why) => { if (batchWhy) return; batchWhy = why; clearTimeout(batchTimer); turnDone?.(); };
          // fallback: close after BATCH_IDLE_MS with no stream activity (message_stop is the primary signal;
          // a fixed window from the first block cut Fable off mid-batch while it was still writing arguments)
          const kickBatchTimer = () => { if (!toolUses.length || batchWhy) return; clearTimeout(batchTimer); batchTimer = setTimeout(() => closeBatch("idle"), BATCH_IDLE_MS); };
          const runPromise = manager.run(sdkModel, cacheKey, blocks, (msg) => {
            if (ac.aborted) return; // dead request: tool batches stay in cli.unobserved for the next one
            if (mcpMode && msg.type === "assistant") {
              const tus = (msg.message?.content || []).filter((b) => b.type === "tool_use");
              // the CLI emits one assistant message per content block: collect until message_stop
              if (tus.length) {
                toolUses.push(...tus);
                kickBatchTimer();
                if (msgStopped && toolUses.length >= expectedTus) closeBatch("late-block");
              }
            }
            if (mcpMode && msg.type === "stream_event") kickBatchTimer();
            if (mcpMode && msg.type === "stream_event" && msg.event?.type === "content_block_start" && msg.event.content_block?.type === "tool_use") expectedTus++;
            if (mcpMode && msg.type === "stream_event" && msg.event?.type === "message_stop") {
              msgStopped = true;
              if (toolUses.length && toolUses.length >= expectedTus) closeBatch("stop");
            }
            if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "thinking_delta") {
              const thinking = msg.event.delta?.thinking;
              if (thinking) send(sseChunk(id, model, { reasoning_content: thinking })); // Vellum renders as thinking
              return;
            }
            if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
              const text = msg.event.delta?.text;
              if (!text) return;
              sawDelta = true;
              if (hasTools && !mcpMode) buffer += text;   // text mode must buffer to detect TOOL_CALL
              else send(sseChunk(id, model, { content: text }));
            } else if (msg.type === "assistant" && !sawDelta) {
              const text = (msg.message?.content || [])
                .filter((b) => b.type === "text").map((b) => b.text).join("");
              if (!text) return;
              if (hasTools && !mcpMode) buffer += text;
              else send(sseChunk(id, model, { content: text }));
            }
          }, effort, mcp, extra);

          // mcp mode: the CLI turn does not end while handlers wait for Vellum, so
          // race the run against "a tool_use batch arrived" and answer Vellum then.
          let result;
          if (mcpMode) {
            const gotTools = new Promise((r) => (turnDone = r));
            const gone = new Promise((r) => (ac.onGone = r));
            const which = await Promise.race([runPromise.then(() => "done", () => "done"), gotTools.then(() => "tools"), gone.then(() => "gone")]);
            if (which === "gone") { runPromise.catch(() => {}); return; }
            if (which === "tools") {
              clearTimeout(batchTimer);
              console.log(`[mcp] batch closed: ${batchWhy || "run-done"} collected=${toolUses.length} expected=${expectedTus}`);
              const tool_calls = toolUses.map((tu, i) => ({ index: i, id: tu.id, type: "function", function: { name: tu.name.replace(/^mcp__vellum__/, ""), arguments: JSON.stringify(tu.input ?? {}) } }));
              // the handler registered under a provisional id; re-key it to the real tool_use id
              for (const tu of toolUses) { rekeyPending(tu, cacheKey); emittedToolIds.add(tu.id); }
              if (emittedToolIds.size > 5000) emittedToolIds.delete(emittedToolIds.values().next().value);
              if (cacheKey) manager.chats.get(cacheKey)?.cli?.markObserved();
              send(sseChunk(id, model, { tool_calls }));
              send(sseChunk(id, model, {}, "tool_calls"));
              console.log(`[res] tool_calls(mcp)=${toolUses.map((t) => t.name).join(",")} pending=${pendingToolUses.size}`);
              // the CLI run continues in the background until Vellum's next request resolves the handler;
              // release the per-chat lock now so that request can enter (it only resolves handlers + feeds nothing new)
              runPromise.catch(() => {});
              send("data: [DONE]\n\n");
              closed = true; // anything the CLI emits before Vellum's next request attaches is dropped, not written here
              if (ac.rel) ac.rel(); else if (cacheKey) manager.chats.get(cacheKey)?.releaseForTools?.();
              return;
            }
            result = await runPromise;
          } else {
            result = await runPromise;
          }

          if (hasTools && !mcpMode) {
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
            if (result?.structured_output !== undefined && !sawDelta) send(sseChunk(id, model, { content: typeof result.structured_output === "string" ? result.structured_output : JSON.stringify(result.structured_output) }));
            send(sseChunk(id, model, {}, "stop"));
          }
          const usage = usageFromResult(result);
          if (usage) {
            const ctx = result?.shim_context_usage ?? await manager.contextUsage(cacheKey);
            if (ctx) usage.context_usage = ctx;
            if (manager.rateLimits) usage.rate_limits = manager.rateLimits.info;
            if (result?.shim_actual_model) usage.actual_model = result.shim_actual_model;
            if (typeof result?.total_cost_usd === "number") usage.cost_usd = result.total_cost_usd;
            send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
            if (ctx) console.log(`[ctx] ${JSON.stringify(ctx).slice(0, 300)}`);
            const d = usage.prompt_tokens_details;
            const uncached = usage.prompt_tokens - d.cached_tokens - d.cache_write_tokens;
            console.log(`[usage] model=${model} actual=${usage.actual_model ?? "?"} cost=${usage.cost_usd ?? "?"} prompt=${usage.prompt_tokens} cached=${d.cached_tokens} cache_write=${d.cache_write_tokens} uncached=${uncached} out=${usage.completion_tokens}`);
          }
          send("data: [DONE]\n\n");
        } catch (e) {
          console.error("[err]", e);
          send(`data: ${JSON.stringify({ error: { message: String(e) } })}\n\n`);
        } finally {
          clearInterval(ka);
          closed = true;
          try { controller.close(); } catch {}
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

console.log(`claude-shim ${SHIM_VERSION} listening on 127.0.0.1:${PORT} verbatim=${VERBATIM} fallback=${FALLBACK_MODEL || "off"} ctxUsage=${CTX_USAGE} precompact=${PRECOMPUTE_COMPACT} snapshot=${SYS_SNAPSHOT} (tools: ${TOOL_MODE === "mcp" ? "sdk-mcp" : "prompt-contract"}, one cli per chat, maxLive=${MAX_LIVE}, idleTtl=${IDLE_TTL_MS/1000}s)`);
