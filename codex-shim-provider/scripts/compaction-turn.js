// Native compaction runs as its own Codex turn (turn_kind: Compact). The thread is only free
// for a new turn/start after that turn's turn/completed; item/completed(contextCompaction)
// arrives earlier and must NOT release waiting turns (that race produced
// "ActiveTurnNotSteerable { turn_kind: Compact }" on Oct 4 2026).

export function createCompactionTracker() {
  const s = { sawCompactionItem: false, turnCompleted: false, failed: null };
  return {
    state: s,
    onNotification(method, p = {}) {
      if (method === "item/completed" && p.item?.type === "contextCompaction") s.sawCompactionItem = true;
      if (method === "turn/completed") {
        if (p.turn?.status === "failed" || p.turn?.error) s.failed = p.turn?.error?.message || "compaction turn failed";
        else s.turnCompleted = true;
      }
    },
    get finished() { return s.turnCompleted || s.failed != null; },
    get compacted() { return s.turnCompleted && s.failed == null; },
  };
}

export function isCompactTurnBusy(e) {
  return /ActiveTurnNotSteerable\s*\{\s*turn_kind:\s*Compact\s*\}/.test(String(e?.message ?? e));
}

// turn/start that tolerates a compaction turn still closing out. Only the Compact busy error is
// retried; any other error is thrown immediately.
export async function startTurnWithRetry(request, params, opts = {}) {
  const { timeoutMs = 10000, delayMs = 500, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = opts;
  const t0 = now(); let attempt = 0;
  while (true) {
    try { return await request("turn/start", params); }
    catch (e) {
      if (!isCompactTurnBusy(e) || now() - t0 + delayMs > timeoutMs) throw e;
      attempt++; log(`[compact] turn/start busy (compaction turn still active) — retry ${attempt} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}
