#!/usr/bin/env bun
// codex-shim — OpenAI-compatible chat/completions proxy in front of the Codex CLI
// (ChatGPT subscription, no API key). Analog of claude-shim, v1: per-turn process
// (`codex exec` / `codex exec resume <thread>`), session continuity via thread id
// on disk, tools via the text prompt contract (TOOL_CALL lines).
//
// Env:
//   SHIM_PORT        (default 8321)
//   CODEX_BIN        (default ~/.local/bin/codex)
//   CODEX_WORKDIR    (default ~/codex-shim/workdir — cwd for codex, read-only sandbox)
//   SHIM_SESSIONS_DIR(default ./sessions)
//   SHIM_MODELS      (comma list, default from models.json or fallback)
//   SHIM_DEBUG=1     verbose request logging

import { spawn } from "bun";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.SHIM_PORT || 8321);
const HOME = process.env.HOME;
const CODEX_BIN = process.env.CODEX_BIN || join(HOME, ".local/bin/codex");
const WORKDIR = process.env.CODEX_WORKDIR || join(HOME, "codex-shim/workdir");
const SESS_DIR = process.env.SHIM_SESSIONS_DIR || join(HOME, "codex-shim/sessions");
const DEBUG = !!process.env.SHIM_DEBUG;
const TOOL_WAIT_NOTE = true;

mkdirSync(SESS_DIR, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

const FALLBACK_MODELS = ["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5"];
function models() {
  if (process.env.SHIM_MODELS) return process.env.SHIM_MODELS.split(",").map(s => s.trim()).filter(Boolean);
  try {
    const mj = JSON.parse(readFileSync(join(HOME, ".codex/models.json"), "utf8"));
    const ids = (mj.models || mj).map(m => m.slug || m.id).filter(Boolean);
    if (ids.length) return ids;
  } catch {}
  return FALLBACK_MODELS;
}

const sha1 = s => createHash("sha1").update(s).digest("hex");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => DEBUG && log(...a);

// ---------- per-chat state ----------
// state: { threadId, sent: [sha1 of fed blocks], model, sysHash }
function sessPath(key) { return join(SESS_DIR, sha1(key) + ".json"); }
function loadState(key) {
  try { return JSON.parse(readFileSync(sessPath(key), "utf8")); } catch { return null; }
}
function saveState(key, st) { writeFileSync(sessPath(key), JSON.stringify(st, null, 2)); }

// ---------- message → feedable blocks ----------
// Only user + tool blocks are ever fed to codex (its own transcript has the rest).
function blocksOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      const c = typeof m.content === "string" ? m.content
        : (m.content || []).map(p => p.type === "text" ? p.text : "").join("\n");
      if (c.trim()) out.push({ kind: "user", text: c });
    } else if (m.role === "tool") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      out.push({ kind: "tool", id: m.tool_call_id || "", text: c });
    }
  }
  return out;
}
const blockHash = b => sha1(b.kind + ":" + b.id + ":" + b.text);

function systemText(messages, tools) {
  let sys = (messages || []).filter(m => m.role === "system" || m.role === "developer")
    .map(m => typeof m.content === "string" ? m.content : (m.content || []).map(p => p.text || "").join("\n"))
    .join("\n\n");
  if (tools && tools.length) {
    const defs = tools.map(t => ({
      name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters,
    }));
    sys += `\n\n<tools>\nYou can call tools. Tool definitions (JSON Schema):\n${JSON.stringify(defs, null, 2)}\n` +
      `To call tools, emit lines of the form:\nTOOL_CALL: {"name": "<tool>", "arguments": {...}}\n` +
      `One line per call. When you emit TOOL_CALL lines, emit NOTHING else — no prose, no results. ` +
      `The caller will execute them and send you the results as <tool_result name="...">...</tool_result>. ` +
      `Never invent or write tool results yourself.\n</tools>`;
  }
  return sys;
}

// ---------- TOOL_CALL parsing ----------
function parseToolCalls(text) {
  const calls = [];
  const lines = text.split("\n");
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*TOOL_CALL:\s*(\{.*)$/);
    if (m) {
      // support multi-line JSON: keep appending until it parses
      let buf = m[1], j = i;
      let parsed = null;
      while (j < lines.length) {
        try { parsed = JSON.parse(buf); break; } catch { j++; if (j < lines.length) buf += "\n" + lines[j]; }
      }
      if (parsed && parsed.name) {
        calls.push({ name: parsed.name, arguments: parsed.arguments ?? parsed.args ?? {} });
        if (firstIdx < 0) firstIdx = i;
        i = j;
      }
    }
  }
  return { calls, firstIdx };
}

// ---------- codex process ----------
async function runCodex({ model, prompt, threadId, instructionsFile, signal, onEvent }) {
  const args = [CODEX_BIN, "exec"];
  if (threadId) {
    args.push("resume", threadId, "--json", "--skip-git-repo-check", "-m", model, "-c", "model_reasoning_summary=auto");
  } else {
    args.push("--json", "--skip-git-repo-check", "-C", WORKDIR, "-m", model, "-c", "model_reasoning_summary=auto");
    if (process.env.SHIM_SANDBOX === "danger") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-s", "workspace-write");
    }
    if (instructionsFile) args.push("-c", `model_instructions_file=${JSON.stringify(instructionsFile)}`);
    args.push("--color", "never");
  }
  args.push("-"); // prompt via stdin — argv hits E2BIG on long conversations
  dbg("[spawn]", args.map(a => a.slice(0, 60)).join(" "), `promptBytes=${prompt.length}`);
  const proc = spawn({ cmd: args, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_HOME: join(HOME, ".codex") } });
  const result = { threadId: null, text: "", usage: null, errors: [], reasoning: [] };
  let buf = "";
  const handleLine = line => {
    if (!line.trim().startsWith("{")) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "thread.started") result.threadId = ev.thread_id;
    else if (ev.type === "item.completed") {
      const it = ev.item || {};
      if ((it.type === "agent_message" || it.type === "message") && typeof it.text === "string") {
        result.text += (result.text ? "\n" : "") + it.text;
        onEvent?.({ kind: "agent_text", text: it.text });
      } else if (it.type === "reasoning" && typeof it.text === "string") {
        result.reasoning.push(it.text);
        onEvent?.({ kind: "reasoning", text: it.text });
      } else if (it.type === "error") result.errors.push(it.message || JSON.stringify(it));
      else dbg("[item]", it.type, JSON.stringify(it).slice(0, 200));
    } else if (ev.type === "turn.completed" && ev.usage) result.usage = ev.usage;
    else if (ev.type === "turn.failed") result.errors.push(ev.error?.message || JSON.stringify(ev));
    else if (ev.type === "error") result.errors.push(ev.message || JSON.stringify(ev));
  };
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  const onAbort = () => { try { proc.kill(); } catch {} };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, idx); buf = buf.slice(idx + 1); handleLine(line); }
  }
  if (buf.trim()) handleLine(buf);
  const err = await new Response(proc.stderr).text();
  result.code = await proc.exited;
  result.stderr = err;
  return result;
}

// extract agent text + thread id + usage from codex --json output
function parseEvents(jsonl) {
  let threadId = null, text = "", usage = null;
  const errors = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "thread.started") threadId = ev.thread_id;
    else if (ev.type === "item.completed") {
      const it = ev.item || {};
      if ((it.type === "agent_message" || it.type === "message") && typeof it.text === "string") text += (text ? "\n" : "") + it.text;
      else if (it.type === "error") errors.push(it.message || JSON.stringify(it));
    } else if (ev.type === "turn.completed" && ev.usage) {
      usage = ev.usage;
    } else if (ev.type === "turn.failed") {
      errors.push(ev.error?.message || JSON.stringify(ev));
    } else if (ev.type === "error") errors.push(ev.message || JSON.stringify(ev));
  }
  return { threadId, text, usage, errors };
}

// ---------- HTTP ----------
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
const cid = () => "chatcmpl-" + Math.random().toString(36).slice(2);

async function handleChat(req) {
  const body = await req.json();
  const model = body.model || models()[0];
  const messages = body.messages || [];
  const tools = body.tools || null;
  const key = body.prompt_cache_key || null;
  const id = cid();
  const t0 = Date.now();
  log(`[req] model=${model} key=${key ? key.slice(0, 8) : "-"} msgs=${messages.length} tools=${tools ? tools.length : 0}`);

  const sys = systemText(messages, tools);
  const sysHash = sha1(sys);
  const blocks = blocksOf(messages);

  let state = key ? loadState(key) : null;
  if (state && state.model !== model) state = null;          // model switch → fresh thread
  if (state && state.sysHash !== sysHash) {
    // system prompt / tools changed → instructions live in the thread, can't be
    // replaced on resume. Fresh thread is cheaper than confusing the model.
    log(`[sess] ${key?.slice(0, 8)} system prompt changed — starting fresh thread`);
    state = null;
  }

  // system prompt goes in as codex base instructions (model_instructions_file),
  // replacing codex's own agent prompt entirely so it doesn't interfere.
  let instructionsFile = null;
  if (!state && sys) {
    instructionsFile = join(SESS_DIR, "instr-" + sysHash.slice(0, 16) + ".md");
    if (!existsSync(instructionsFile)) writeFileSync(instructionsFile, sys);
  }

  // figure out which blocks codex hasn't seen
  let toFeed = blocks;
  if (state) {
    const seen = new Set(state.sent);
    const unseen = [];
    for (const b of blocks) { if (!seen.has(blockHash(b))) unseen.push(b); }
    toFeed = unseen;
  }

  // build prompt text (user/tool blocks only — system lives in instructions file)
  const parts = [];
  for (const b of toFeed) {
    parts.push(b.kind === "tool"
      ? `<tool_result${b.id ? ` id="${b.id}"` : ""}>\n${b.text}\n</tool_result>`
      : b.text);
  }
  const prompt = parts.join("\n\n");
  if (!prompt.trim()) {
    return jsonResp({ error: { message: "nothing new to feed", type: "invalid_request_error" } }, 400);
  }

  const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" };
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const res = { write: s => controller.enqueue(enc.encode(s)), close: () => controller.close() };
      let agentSent = 0;
      const onEvent = ev => {
        if (ev.kind === "reasoning") {
          sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: ev.text + "\n\n" } }] });
        } else if (ev.kind === "agent_text" && !tools) {
          // no tools: safe to stream immediately. with tools we must buffer —
          // the text may contain TOOL_CALL lines that become tool_calls, not content
          sse(res, { ...base, choices: [{ index: 0, delta: { content: (agentSent++ ? "\n" : "") + ev.text } }] });
        }
      };
      let r;
      try {
        r = await runCodex({ model, prompt, threadId: state?.threadId || null, instructionsFile, signal: req.signal, onEvent });
      } catch (e) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: "⚠ codex spawn failed: " + String(e).slice(0, 300) }, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n"); res.close(); return;
      }
      const { threadId, text, usage, errors } = r;
      if (threadId) {
        state = { threadId, sent: blocks.map(blockHash), model, sysHash };
        if (key) saveState(key, state);
      }
      dbg("[codex exit]", r.code, (r.stderr || "").slice(0, 400));
      const finish = finish_reason => sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason }] });

      if (!text && errors.length) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: "⚠ codex: " + errors.join("; ").slice(0, 500) } }] });
        finish("stop");
      } else {
        const { calls } = tools ? parseToolCalls(text) : { calls: [] };
        if (calls.length) {
          const tc = calls.map((c, i) => ({
            index: i, id: "call_" + Math.random().toString(36).slice(2),
            type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
          sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: tc } }] });
          finish("tool_calls");
          log(`[res] tool_calls=${calls.map(c => c.name).join(",")} ${Date.now() - t0}ms`);
        } else {
          if (tools && text && agentSent === 0) {
            // buffered because of tools, but no TOOL_CALL found → it's plain content
            sse(res, { ...base, choices: [{ index: 0, delta: { content: text } }] });
          }
          finish("stop");
        }
      }
      if (usage) {
        sse(res, { ...base, choices: [], usage: {
          prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          prompt_tokens_details: usage.cached_input_tokens != null ? { cached_tokens: usage.cached_input_tokens } : undefined,
        }});
      }
      res.write("data: [DONE]\n\n");
      res.close();
      log(`[res] ${text ? text.length + " chars" : "EMPTY"} reasoning=${r.reasoning.length} ${Date.now() - t0}ms`);
    },
  });
  return new Response(stream, { headers });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return jsonResp({ object: "list", data: models().map(m => ({ id: m, object: "model", created: 0, owned_by: "codex-cli" })) });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try { return await handleChat(req); }
      catch (e) { log("[err]", e); return jsonResp({ error: { message: String(e), type: "server_error" } }, 500); }
    }
    if (url.pathname === "/chats" || url.pathname === "/pool") {
      // list session files
      const { readdirSync, statSync } = await import("fs");
      const chats = readdirSync(SESS_DIR).filter(f => f.endsWith(".json")).map(f => {
        const st = JSON.parse(readFileSync(join(SESS_DIR, f), "utf8"));
        return { file: f, model: st.model, threadId: st.threadId, ageMin: Math.round((Date.now() - statSync(join(SESS_DIR, f)).mtimeMs) / 60000) };
      });
      return jsonResp({ chats });
    }
    return jsonResp({ error: "not found" }, 404);
  },
});

log(`codex-shim listening on 127.0.0.1:${PORT} (tools: text-contract, models: ${models().join(",")})`);
