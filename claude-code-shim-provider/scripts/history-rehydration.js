// A warm CLI already owns its replies; a FRESH CLI owns no history at all.
// Rehydrate every non-system message, including Vellum's assistant-role
// <context_summary>, in chronological order. Tool calls are recorded text,
// never executed or answered as live RPCs from an old thread.
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
export function historyToPrompt(messages) {
  const records = [];
  for (const m of messages || []) {
    if (["system", "developer"].includes(m.role)) continue;
    const lines = [messageText(m.content)];
    for (const call of m.tool_calls || []) {
      lines.push(`[Recorded tool call ${call.function?.name || "tool"} id=${call.id || ""}] ${typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})}`);
    }
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
