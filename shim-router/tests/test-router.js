import { strict as assert } from "node:assert";
import { inspectResponse, semanticFailure, parseDecisionText, completionFromParsed, oneUseKeyFor, rememberToolCalls, releaseOneUse } from "../scripts/server.js";
const sse = (xs) => xs.map((x) => "data: " + (x === "[DONE]" ? x : JSON.stringify(x)) + "\n\n").join("");
const ok = inspectResponse(sse([
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { content: "OK" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"
]), "text/event-stream");
assert.equal(ok.ok, true); assert.equal(ok.content, "OK");
const err = inspectResponse(sse([{ choices: [{ delta: { role: "assistant" } }] }, { error: { message: "You've hit your session limit · resets 5:40pm UTC" } }, "[DONE]"]), "text/event-stream");
assert.equal(err.ok, false); assert.equal(err.kind, "upstream_error");
const sem = inspectResponse(sse([{ choices: [{ delta: { content: "⚠ codex: usage limit reached" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]), "text/event-stream");
assert.equal(sem.ok, false); assert.equal(sem.kind, "semantic_error"); assert.ok(semanticFailure("insufficient credits"));
const tools = inspectResponse(sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "recall", arguments: "{\\\"q\\\":" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\\\"x\\\"}" } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, "[DONE]"
]), "text/event-stream");
assert.equal(tools.ok, true); assert.equal(tools.toolCalls[0].id, "call_abc"); assert.equal(tools.toolCalls[0].function.arguments, "{\\\"q\\\":\\\"x\\\"}");
const k1 = oneUseKeyFor({ messages: [{ role: "user", content: "a" }] }); assert.match(k1, /^router-oneuse-[0-9a-f-]{36}$/);
rememberToolCalls(k1, tools);
const k2 = oneUseKeyFor({ messages: [{ role: "tool", tool_call_id: "call_abc", content: "r" }] }); assert.equal(k2, k1);
releaseOneUse(k1);
const k3 = oneUseKeyFor({ messages: [{ role: "tool", tool_call_id: "call_abc", content: "r" }] }); assert.notEqual(k3, k1);
assert.equal(parseDecisionText('{"action":"disable","disable_until":"2026-10-03T04:02:00Z","reason":"лимит","confidence":0.9}').action, "disable");
assert.equal(parseDecisionText("nonsense"), null);
assert.equal(completionFromParsed(ok).choices[0].message.content, "OK");
console.log("shim-router unit tests: OK");
