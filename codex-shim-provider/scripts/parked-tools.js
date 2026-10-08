// The upstream turn outlives any one HTTP response. Native exec may yield while a
// dynamic tool is still outstanding, then issue another dynamic call much later.
// Keep call arguments and delivery state in the session, not the HTTP closure.
export function pendingToolCalls(state) {
  return Object.entries(state?.parked || {})
    .filter(([, call]) => call.delivered === false)
    .map(([callId, call]) => ({ callId, name: call.name, arguments: call.arguments }));
}

export function parkToolCall(state, request, newId) {
  state.parked ||= {};
  const duplicate = Object.entries(state.parked).find(([, call]) => call.rpcId === request.id);
  if (duplicate) return duplicate[0];
  state.parked[newId] = {
    rpcId: request.id,
    name: request.params.tool,
    cliId: request.params.callId || request.params.itemId || request.params.id || `rpc:${request.id}`,
    arguments: request.params.arguments,
    delivered: false,
  };
  return newId;
}

export function markToolsDelivered(state, calls) {
  for (const call of calls) {
    if (state.parked?.[call.callId]) state.parked[call.callId].delivered = true;
  }
}

export function toolFailure(text) {
  return { contentItems: [{ type: "inputText", text }], success: false };
}
