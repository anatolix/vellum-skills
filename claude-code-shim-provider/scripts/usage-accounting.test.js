import { describe, expect, test } from "bun:test";
import { ClaudeUsageAccounting } from "./usage-accounting.js";
const usage = (input, read = 0, write = 0, output = 0) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });
const start = (a, id, u) => a.observe({ type: "stream_event", event: { type: "message_start", message: { id, usage: u } } });
const delta = (a, output) => a.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } });
const assistant = (a, id, u) => a.observe({ type: "assistant", message: { id, usage: u } });
const result = (a, u) => a.observe({ type: "result", usage: u });
const take = a => { const u = a.peek(); a.acknowledge(u); return u; };

describe("Claude usage: sum model messages, emit only undelivered deltas", () => {
  test("cold history plus cached continuation, including cache writes and outputs", () => {
    const a = new ClaudeUsageAccounting();
    start(a, "cold", usage(1000, 0, 500)); delta(a, 50);
    start(a, "warm", usage(20, 1500, 100)); delta(a, 30);
    expect(take(a)).toEqual({ prompt_tokens: 3120, completion_tokens: 80, total_tokens: 3200,
      prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 600 } });
  });
  test("tool pause followed by SDK aggregate does not bill cold call twice", () => {
    const a = new ClaudeUsageAccounting();
    start(a, "cold", usage(1000, 0, 500)); delta(a, 50);
    const first = take(a);
    start(a, "warm", usage(20, 1500, 100)); delta(a, 30);
    result(a, usage(1020, 1500, 600, 80));
    const second = take(a);
    expect(first.prompt_tokens + second.prompt_tokens).toBe(3120);
    expect(second.prompt_tokens).toBe(1620);
    expect(second.completion_tokens).toBe(30);
    expect(take(a)).toBeNull();
  });
  test("stream and per-block assistant snapshots of same ID are counted once", () => {
    const a = new ClaudeUsageAccounting(), u = usage(20, 500, 100, 30);
    start(a, "msg-1", { ...u, output_tokens: 1 }); delta(a, 30);
    assistant(a, "msg-1", u); assistant(a, "msg-1", u);
    result(a, u);
    expect(take(a).prompt_tokens).toBe(620);
    result(a, u); assistant(a, "msg-1", u);
    expect(take(a)).toBeNull();
  });
  test("identical successive messages have separate IDs and must both count", () => {
    const a = new ClaudeUsageAccounting(), u = usage(20, 500, 100, 30);
    assistant(a, "msg-1", u); assistant(a, "msg-2", u);
    expect(take(a).prompt_tokens).toBe(1240);
  });
  test("events arriving while HTTP is closed are retained for next attach", () => {
    const a = new ClaudeUsageAccounting();
    expect(take(a)).toBeNull();
    assistant(a, "late-cold", usage(1000, 0, 0, 50));
    start(a, "next", usage(20, 1000)); delta(a, 30);
    expect(take(a).prompt_tokens).toBe(2020);
  });
  test("aggregate result fills missing stream steps, subtracting delivered usage", () => {
    const a = new ClaudeUsageAccounting();
    assistant(a, "step-1", usage(100, 0, 20, 10));
    take(a);
    result(a, usage(105, 120, 25, 40));
    expect(take(a)).toEqual({ prompt_tokens: 130, completion_tokens: 30, total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 120, cache_write_tokens: 5 } });
  });
  test("late assistant after result does not duplicate aggregate fallback", () => {
    const a = new ClaudeUsageAccounting(), u = usage(100, 500, 20, 30);
    result(a, u); take(a);
    assistant(a, "msg-1", u);
    expect(take(a)).toBeNull();
  });
  test("result-only one-shot exposes inclusive Anthropic prompt total", () => {
    const a = new ClaudeUsageAccounting();
    result(a, usage(2, 75960, 819, 48));
    expect(take(a)).toEqual({ prompt_tokens: 76781, completion_tokens: 48, total_tokens: 76829,
      prompt_tokens_details: { cached_tokens: 75960, cache_write_tokens: 819 } });
  });
  test("new SDK run counts its own usage, not previous run's aggregate", () => {
    const a = new ClaudeUsageAccounting();
    result(a, usage(1000, 0, 500, 50)); take(a);
    a.startRun();
    result(a, usage(20, 1500, 100, 30));
    expect(take(a).prompt_tokens).toBe(1620);
  });
  test("unreported old run usage survives startRun and persisted chat reload", () => {
    let a = new ClaudeUsageAccounting();
    assistant(a, "old", usage(1000, 0, 0, 50));
    a = new ClaudeUsageAccounting(JSON.parse(JSON.stringify(a.snapshot())));
    a.startRun();
    result(a, usage(20, 1000, 0, 30));
    expect(take(a).prompt_tokens).toBe(2020);
  });
  test("failed delivery leaves pending counters untouched", () => {
    const a = new ClaudeUsageAccounting();
    result(a, usage(100, 500, 20, 30));
    const failedWriter = () => false;
    if (failedWriter(a.peek())) a.acknowledge(a.peek());
    expect(take(a).prompt_tokens).toBe(620);
  });
  test("partial output changes add only their increase", () => {
    const a = new ClaudeUsageAccounting();
    start(a, "m", usage(100)); delta(a, 10); take(a);
    delta(a, 15); delta(a, 15);
    expect(take(a)).toEqual({ prompt_tokens: 0, completion_tokens: 5, total_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  });
  test("re-emitted unanswered batch is not a new model call", () => {
    const a = new ClaudeUsageAccounting(), u = usage(100, 500, 20, 30);
    assistant(a, "tool-message", u); take(a);
    assistant(a, "tool-message", u);
    expect(take(a)).toBeNull();
  });
  test("assistant without streaming plus fallback model ID are summed", () => {
    const a = new ClaudeUsageAccounting();
    assistant(a, "first-model", usage(100, 0, 0, 10));
    assistant(a, "fallback-model", usage(200, 100, 50, 20));
    expect(take(a).prompt_tokens).toBe(450);
  });
  test("empty/invalid snapshots cannot erase valid counters", () => {
    const a = new ClaudeUsageAccounting();
    start(a, "m", usage(100, 80, 20, 30));
    assistant(a, "m", usage(NaN, -1, Infinity, -1));
    expect(take(a).prompt_tokens).toBe(200);
    expect(a.peek()).toBeNull();
  });
  test("two concurrent CLI sessions do not share usage", () => {
    const a = new ClaudeUsageAccounting(), b = new ClaudeUsageAccounting();
    result(a, usage(100)); result(b, usage(200));
    expect(take(a).prompt_tokens).toBe(100);
    expect(take(b).prompt_tokens).toBe(200);
  });
});
