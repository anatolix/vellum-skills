// These internal Vellum protocols consume each tool batch as a complete response.
// Even recall search/inspection rebuilds the next prompt instead of returning tool_result.
// Do NOT infer this from tool_choice=required or from a router-oneuse key alone.
const OUTPUT_TOOLS = new Set([
  'record_conversation_title', 'select_pages', 'select_pages_to_inject',
  'search_sources', 'inspect_workspace_paths', 'finish_recall',
]);
const toolName = name => String(name || '').replace(/^mcp__vellum__/, '');
export function isOutputOnlyBatch(key, tools, batch) {
  if (!String(key || '').startsWith('router-oneuse-') || !tools?.length || !batch?.length) return false;
  const names = tools.map(t => t?.type === 'function' ? t.function?.name : null);
  if (names.some(n => !n || !OUTPUT_TOOLS.has(n))) return false;
  const advertised = new Set(names);
  return batch.every(t => advertised.has(toolName(t.name)));
}
// Shut down inference BEFORE releasing MCP promises, so acknowledging an output
// cannot accidentally start another paid inference. Cleanup is key-scoped.
export function closeOneUseSession({key, sessions, pending, early, emitted, consumed, waiters, reason = 'done'}) {
  const chat = sessions.get(key);
  if (!chat) return false;
  if (reason === 'output batch') chat.outputComplete = true;
  const cli = chat.cli;
  sessions.delete(key);
  chat.cli = null;
  cli?.close();
  for (const [id, entry] of pending) {
    if (entry.chatKey !== key) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    early?.delete(id); emitted?.delete(id); consumed?.delete(id);
    entry.resolve?.({content: [{type:'text', text:'[shim] one-use session closed'}], isError:true});
  }
  const wake = waiters?.shift(); wake?.();
  return true;
}
