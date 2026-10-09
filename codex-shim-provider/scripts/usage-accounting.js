// Usage belongs to a thread, not an HTTP handler: notifications can arrive after
// a tool_calls response has closed. Persist the undelivered delta in session JSON.
// Codex "total" is a thread-lifetime snapshot; never add snapshots themselves.
const fields = ["input", "output", "cached", "reasoning"];
const names = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"];
const valid = n => Number.isSafeInteger(n) && n >= 0;
const zero = () => Object.fromEntries(fields.map(k => [k, 0]));
const normalized = u => Object.fromEntries(fields.map((k, i) => [k, valid(u?.[names[i]]) ? u[names[i]] : 0]));

export function recordCodexUsage(state, tokenUsage, turnId = "") {
  if (!tokenUsage?.last) return false;
  const a = state.usageAccounting ||= { total: null, pending: zero(), reasoningKnown: false, fallback: null };
  const last = normalized(tokenUsage.last);
  let delta;
  if (valid(tokenUsage.total?.inputTokens) && valid(tokenUsage.total?.outputTokens)) {
    const total = normalized(tokenUsage.total);
    // Old/resumed threads have already-paid history. Seed from total-last, so
    // installing this patch does not bill a whole existing thread a second time.
    delta = a.total ? Object.fromEntries(fields.map(k => [k, Math.max(0, total[k] - a.total[k])])) : last;
    // A reset (e.g. compaction) is not negative usage.
    if (a.total && (total.input < a.total.input || total.output < a.total.output)) delta = last;
    a.total = total;
  } else {
    // Legacy transports without totals: "last" is a snapshot, not an increment.
    // Deduplicate repeated notifications within one turn. Modern Codex supplies
    // total, which also distinguishes identical successive model calls.
    const previous = a.fallback?.turnId === turnId ? a.fallback.last : zero();
    delta = Object.fromEntries(fields.map(k => [k, Math.max(0, last[k] - previous[k])]));
    a.fallback = { turnId, last };
  }
  for (const k of fields) a.pending[k] += delta[k];
  if (valid(tokenUsage.last.reasoningOutputTokens) && fields.some(k => delta[k] > 0)) a.reasoningKnown = true;
  return fields.some(k => delta[k] > 0);
}

export function pendingCodexUsage(state) {
  const a = state.usageAccounting;
  return { ...(a?.pending || zero()), reasoning: a?.reasoningKnown ? a.pending.reasoning : null };
}

export function codexUsageChunk(u) {
  if (!u.input && !u.output && !u.cached && !(u.reasoning > 0)) return null;
  return {
    prompt_tokens: u.input, completion_tokens: u.output,
    total_tokens: u.input + u.output,
    prompt_tokens_details: { cached_tokens: u.cached },
    ...(u.reasoning !== null ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}),
  };
}

export function acknowledgeCodexUsage(state, u) {
  const a = state.usageAccounting;
  if (!a) return;
  for (const k of fields) a.pending[k] = Math.max(0, a.pending[k] - (u[k] || 0));
  if (!fields.some(k => a.pending[k])) a.reasoningKnown = false;
}
