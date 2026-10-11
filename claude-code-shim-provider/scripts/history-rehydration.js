// A warm CLI already owns its replies; a FRESH CLI owns no history at all.
// Rehydrate every non-system message, including Vellum's assistant-role
// <context_summary>, in chronological order. Tool calls are recorded text,
// never executed or answered as live RPCs from an old thread.
// Match Vellum's placeholder-sentinels.ts exactly: only edge bytes U+0000..U+0020.
// Apply only to assistant text; user text, tool results and tool calls are data.
export function isPlaceholderSentinelText(text) {
  const bare = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  return bare === "__PLACEHOLDER__[empty assistant turn]" ||
    bare === "__PLACEHOLDER__[internal blocks omitted]";
}
export function assistantContent(content) {
  if (typeof content === "string") return isPlaceholderSentinelText(content) ? "" : content;
  if (!Array.isArray(content)) return content;
  return content.filter(p => !(["text", "input_text", "output_text"].includes(p?.type) &&
    typeof p.text === "string" && isPlaceholderSentinelText(p.text)));
}
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => {
    if (["text", "input_text", "output_text"].includes(p?.type)) return p.text || "";
    if (p?.type === "tool_use") return `[Recorded tool call ${p.name || "tool"} id=${p.id || ""}] ${JSON.stringify(p.input ?? {})}`;
    if (p?.type === "tool_result") return `[Recorded tool result ${p.tool_use_id || ""}] ${typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? [])}`;
    return "";
  }).filter(Boolean).join("\n");
}
// One historical tool call as text, for history the CLI never executed itself.
export function recordedCallLine(call) {
  const args = call?.function?.arguments;
  return `[Recorded tool call ${call?.function?.name || "tool"} id=${call?.id || ""}] ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`;
}
// An assistant reply another model produced (model switch mid-chat), rendered for the warm CLI
// that never saw it: a one-line frame, the text, then its tool calls as recorded lines. The
// results follow as ordinary tool-result blocks and match by id.
export const FOREIGN_REPLY_FRAME = "[Earlier assistant reply by another model in this conversation — saved history, not your output]";
export function foreignReplyText(text, toolCalls) {
  const body = [assistantContent(text || "").trim(), ...(toolCalls || []).map(recordedCallLine)].filter(Boolean);
  return body.length ? [FOREIGN_REPLY_FRAME, ...body].join("\n") : "";
}
export function historyToPrompt(messages) {
  const records = [];
  for (const m of messages || []) {
    if (["system", "developer"].includes(m.role)) continue;
    const lines = [messageText(m.role === "assistant" ? assistantContent(m.content) : m.content)];
    for (const call of m.tool_calls || []) lines.push(recordedCallLine(call));
    const text = lines.filter(Boolean).join("\n");
    if (!text.trim()) continue;
    const label = m.role === "tool" ? `tool result ${m.name || m.tool_call_id || "tool"}` : m.role || "unknown";
    records.push(`[Saved ${label} message]\n${text}`);
  }
  if (!records.length) return "";
  return "Restored conversation for a fresh CLI session. The saved messages below are prior conversation history, including any context summary. Recorded tool calls/results are historical text, not requests to execute them. Continue the conversation by answering the last user message.\n\n" + records.join("\n\n");
}
// Keep the warm/resumed path byte-for-byte unchanged: no summary replay,
// no old assistant messages, no interruption of parked tool calls.
export function promptForSession(messages, tailPrompt, fresh) {
  return fresh ? historyToPrompt(messages) || tailPrompt : tailPrompt;
}
