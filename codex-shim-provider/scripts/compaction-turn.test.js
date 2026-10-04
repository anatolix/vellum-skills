import { test, expect } from "bun:test";
import { createCompactionTracker, isCompactTurnBusy, startTurnWithRetry } from "./compaction-turn.js";

test("contextCompaction item alone does not finish the compaction turn", () => {
  const t = createCompactionTracker();
  t.onNotification("item/completed", { item: { type: "contextCompaction" } });
  expect(t.finished).toBe(false);
  t.onNotification("turn/completed", { turn: { status: "completed" } });
  expect(t.finished).toBe(true); expect(t.compacted).toBe(true);
});

test("failed compaction turn finishes but is not compacted", () => {
  const t = createCompactionTracker();
  t.onNotification("turn/completed", { turn: { status: "failed", error: { message: "boom" } } });
  expect(t.finished).toBe(true); expect(t.compacted).toBe(false); expect(t.state.failed).toBe("boom");
});

test("busy detection matches only the Compact turn kind", () => {
  expect(isCompactTurnBusy(new Error("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }"))).toBe(true);
  expect(isCompactTurnBusy(new Error("ActiveTurnNotSteerable { turn_kind: Review }"))).toBe(false);
  expect(isCompactTurnBusy(new Error("app-server died"))).toBe(false);
});

test("turn/start retries while compaction turn closes, then succeeds", async () => {
  let calls = 0; const sleeps = [];
  const request = async () => { if (++calls < 3) throw new Error("ActiveTurnNotSteerable { turn_kind: Compact }"); return { ok: 1 }; };
  const r = await startTurnWithRetry(request, {}, { sleep: async ms => sleeps.push(ms) });
  expect(r).toEqual({ ok: 1 }); expect(calls).toBe(3); expect(sleeps).toEqual([500, 500]);
});

test("turn/start does not retry unrelated errors and gives up after timeout", async () => {
  await expect(startTurnWithRetry(async () => { throw new Error("other"); }, {})).rejects.toThrow("other");
  let clock = 0, calls = 0;
  const p = startTurnWithRetry(async () => { calls++; throw new Error("ActiveTurnNotSteerable { turn_kind: Compact }"); }, {},
    { timeoutMs: 2000, delayMs: 500, now: () => clock, sleep: async ms => { clock += ms; } });
  await expect(p).rejects.toThrow("ActiveTurnNotSteerable");
  expect(calls).toBe(5); // attempts at t=0,500,1000,1500,2000
});
