import { describe, expect, test } from "bun:test";
import { recordCodexUsage, pendingCodexUsage, codexUsageChunk, acknowledgeCodexUsage } from "./usage-accounting.js";
const u = (input, cached = 0, output = 0, reasoning = 0) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });
const update = (s, last, total = last) => recordCodexUsage(s, { last, total }, "turn-1");
const take = s => { const p = pendingCodexUsage(s); const chunk = codexUsageChunk(p); if (chunk) acknowledgeCodexUsage(s, p); return chunk; };

describe("Codex usage deltas, never last-step overwrite", () => {
  test("real Oct9 cold + cached continuation keeps BOTH calls", () => {
    const s = {};
    update(s, u(47892, 0, 315, 41));
    update(s, u(48566, 47744, 81), u(96458, 47744, 396, 41));
    const c = take(s);
    expect(c.prompt_tokens).toBe(96458);
    expect(c.prompt_tokens_details.cached_tokens).toBe(47744);
    expect(c.prompt_tokens - c.prompt_tokens_details.cached_tokens).toBe(48714);
    expect(c.completion_tokens).toBe(396);
    expect(c.completion_tokens_details.reasoning_tokens).toBe(41);
    expect(take(s)).toBeNull();
  });
  test("late notification with no HTTP observer is retained across session JSON reload", () => {
    let s = {};
    expect(take(s)).toBeNull(); // tool_calls stream closed before token usage arrives
    update(s, u(47892, 0, 315, 41));
    s = JSON.parse(JSON.stringify(s)); // daemon/request-local handlers discarded
    update(s, u(48566, 47744, 81), u(96458, 47744, 396, 41));
    expect(take(s).prompt_tokens).toBe(96458);
  });
  test("emitted earlier step is not included again in the continuation", () => {
    const s = {};
    update(s, u(1000, 0, 50, 10));
    expect(take(s).prompt_tokens).toBe(1000);
    update(s, u(1100, 1000, 25, 5), u(2100, 1000, 75, 15));
    expect(take(s)).toEqual({ prompt_tokens: 1100, completion_tokens: 25, total_tokens: 1125,
      prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 5 } });
  });
  test("duplicate total notifications before/after HTTP acknowledgement add nothing", () => {
    const s = {}, step = u(900, 800, 40, 10);
    update(s, step); update(s, step);
    expect(take(s).prompt_tokens).toBe(900);
    update(s, step);
    expect(take(s)).toBeNull();
  });
  test("identical successive model calls are distinct when totals advance", () => {
    const s = {}, step = u(900, 800, 40, 10);
    update(s, step); update(s, step, u(1800, 1600, 80, 20));
    expect(take(s).prompt_tokens).toBe(1800);
  });
  test("resumed existing thread excludes old history and captures later calls", () => {
    const s = {};
    update(s, u(100, 80, 10, 2), u(100100, 90080, 5010, 502));
    expect(take(s).prompt_tokens).toBe(100);
    update(s, u(200, 150, 20, 4), u(100300, 90230, 5030, 506));
    expect(take(s).prompt_tokens).toBe(200);
  });
  test("new turn totals do not re-bill the previous turn", () => {
    const s = {};
    update(s, u(100, 50, 10)); take(s);
    recordCodexUsage(s, { last: u(200, 100, 20), total: u(300, 150, 30) }, "turn-2");
    expect(take(s).prompt_tokens).toBe(200);
  });
  test("thread total resets do not subtract pending cold usage", () => {
    const s = {};
    update(s, u(100, 0, 10));
    update(s, u(20, 10, 5), u(20, 10, 5));
    expect(take(s).prompt_tokens).toBe(120);
  });
  test("cancelled/failed write does not acknowledge or erase pending usage", () => {
    const s = {};
    update(s, u(100, 80, 10));
    const failedWriter = () => false;
    const p = pendingCodexUsage(s);
    if (failedWriter(codexUsageChunk(p))) acknowledgeCodexUsage(s, p);
    expect(take(JSON.parse(JSON.stringify(s))).prompt_tokens).toBe(100);
  });
  test("partial legacy snapshots deduplicated, reasoning unavailable stays unknown", () => {
    const s = {};
    recordCodexUsage(s, { last: { inputTokens: 100, outputTokens: 10 } }, "a");
    recordCodexUsage(s, { last: { inputTokens: 100, outputTokens: 10 } }, "a");
    expect(take(s)).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } });
  });
  test("concurrent threads have independent accounting", () => {
    const a = {}, b = {};
    update(a, u(100)); update(b, u(200, 190));
    expect(take(a).prompt_tokens).toBe(100);
    expect(take(b).prompt_tokens).toBe(200);
  });
  test("bad or empty usage cannot create negative/NaN counters", () => {
    const s = {};
    expect(recordCodexUsage(s, {})).toBe(false);
    recordCodexUsage(s, { last: { inputTokens: NaN, outputTokens: -1, cachedInputTokens: Infinity } });
    expect(take(s)).toBeNull();
  });
});
