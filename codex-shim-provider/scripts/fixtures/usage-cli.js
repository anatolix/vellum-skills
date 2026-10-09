#!/usr/bin/env bun
// Test-only app-server: no model, credentials, files, or external network.
import { createInterface } from "node:readline";
const send = x => process.stdout.write(JSON.stringify(x) + "\n");
const tid = "usage-test-thread";
const step = (input, cached, output, reasoning) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });
const notifyUsage = (last, total = last) => send({ method: "thread/tokenUsage/updated", params: { threadId: tid, turnId: "turn-1", tokenUsage: { last, total } } });
const cold = step(47892, 0, 315, 41), warm = step(48566, 47744, 81, 0), total = step(96458, 47744, 396, 41);
let running = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method && m.id === 999) {
    notifyUsage(warm, total); notifyUsage(warm, total); // duplicate snapshots
    send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "done" } });
    send({ method: "turn/completed", params: { threadId: tid, turn: { id: "turn-1", status: "completed" } } });
    continue;
  }
  let result = {};
  if (m.method === "thread/start") result = { thread: { id: tid } };
  if (m.method === "model/list") result = { data: [{ id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
  send({ id: m.id, result });
  if (m.method === "turn/start" && !running) {
    running = true;
    if (process.env.SHIM_TEST_USAGE_MODE === "internal") {
      notifyUsage(cold); notifyUsage(warm, total);
      send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "done" } });
      send({ method: "turn/completed", params: { threadId: tid, turn: { id: "turn-1", status: "completed" } } });
      continue;
    }
    if (process.env.SHIM_TEST_USAGE_MODE !== "late") notifyUsage(cold);
    send({ id: 999, method: "item/tool/call", params: { threadId: tid, callId: "cli-tool-1", tool: "echo", arguments: {} } });
    if (process.env.SHIM_TEST_USAGE_MODE === "late") setTimeout(() => { notifyUsage(cold); notifyUsage(cold); }, 900);
  }
}
