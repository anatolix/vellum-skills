// OpenAI-compatible chat completions shim backed by Claude Code (Agent SDK + OAuth token).
// Listens on 127.0.0.1:8317. Endpoints: POST /v1/chat/completions (SSE), GET /v1/models.
//
// Tool calling: OpenAI `tools` are rendered into the prompt as a text contract.
// The model emits `TOOL_CALL: {"name": ..., "arguments": {...}}` lines; we parse them
// and return real OpenAI `tool_calls` deltas. Tool execution stays on the Vellum side.
// Claude Code's own SDK tools (Bash/Read/...) remain disabled on purpose.
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = 8317;

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

function messagesToPrompt(messages, tools) {
  const parts = [];
  if (Array.isArray(tools) && tools.length) {
    const defs = tools
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      }));
    parts.push(`<tools>\n${JSON.stringify(defs, null, 1)}\n</tools>\n\n${TOOL_INSTRUCTIONS}`);
  }
  for (const m of messages) {
    const role = m.role;
    const text = contentToText(m.content);
    if (role === "system") {
      parts.push(`<system>\n${text}\n</system>`);
    } else if (role === "user") {
      parts.push(`Human: ${text}`);
    } else if (role === "assistant") {
      const lines = [];
      if (text) lines.push(text);
      for (const tc of m.tool_calls || []) lines.push(`TOOL_CALL: ${tcToJson(tc)}`);
      parts.push(`Assistant: ${lines.join("\n")}`);
    } else if (role === "tool") {
      const label = m.name || m.tool_call_id || "tool";
      parts.push(`<tool_result name="${label}">\n${text}\n</tool_result>`);
    } else {
      parts.push(`${role}: ${text}`);
    }
  }
  parts.push("Assistant:");
  return parts.join("\n\n");
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

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    let body;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

    const model = body.model || "claude-opus";
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasTools = tools.length > 0;
    console.log(`[req] model=${model} msgs=${(body.messages || []).length} tools=${tools.length} token_len=${(process.env.CLAUDE_CODE_OAUTH_TOKEN || "").length}`);
    const sdkModel = model.replace(/^claude-/, ""); // opus | sonnet | haiku
    const prompt = messagesToPrompt(body.messages || [], tools);
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (s) => controller.enqueue(enc.encode(s));
        try {
          send(sseChunk(id, model, { role: "assistant" }));
          const q = query({
            prompt,
            options: {
              model: sdkModel,
              env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
              // Claude Code's own tools stay off: execution belongs to Vellum.
              tools: [],
              allowedTools: [],
              permissionMode: "bypassPermissions",
              settingSources: [],
              maxTurns: 1,
            },
          });

          let buffer = "";
          let sawDelta = false;
          for await (const msg of q) {
            if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
              const text = msg.event.delta?.text;
              if (!text) continue;
              sawDelta = true;
              if (hasTools) buffer += text;               // must buffer to detect TOOL_CALL
              else send(sseChunk(id, model, { content: text }));
            } else if (msg.type === "assistant" && !sawDelta) {
              const text = (msg.message?.content || [])
                .filter((b) => b.type === "text").map((b) => b.text).join("");
              if (!text) continue;
              if (hasTools) buffer += text;
              else send(sseChunk(id, model, { content: text }));
            }
          }

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

console.log(`claude-shim listening on 127.0.0.1:${PORT} (tools: prompt-contract)`);
