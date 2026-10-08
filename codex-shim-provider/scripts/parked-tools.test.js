import { expect, test } from "bun:test";
import { pendingToolCalls, parkToolCall, markToolsDelivered, toolFailure } from "./parked-tools.js";
const req = (id, name = "ui_show") => ({ id, params: { tool: name, arguments: { value: "card" }, callId: "cli-" + id } });
test("RPC id 0, dedup, durable arguments, delivered calls not re-emitted", () => {
  const state = { parked: {} };
  expect(parkToolCall(state, req(0), "call-0")).toBe("call-0");
  expect(parkToolCall(state, req(0), "duplicate")).toBe("call-0");
  parkToolCall(state, req(1), "call-1");
  const restored = JSON.parse(JSON.stringify(state));
  expect(pendingToolCalls(restored)).toHaveLength(2);
  expect(pendingToolCalls(restored)[0].arguments).toEqual({ value: "card" });
  markToolsDelivered(restored, [pendingToolCalls(restored)[0]]);
  expect(pendingToolCalls(restored).map(c => c.callId)).toEqual(["call-1"]);
  expect(restored.parked["call-0"].rpcId).toBe(0);
});
test("pre-patch parked calls are already delivered; valid explicit failure", () => {
  const state = { parked: { legacy: { rpcId: 42, name: "bash" } } };
  expect(pendingToolCalls(state)).toEqual([]);
  expect(toolFailure("not executed")).toEqual({ contentItems: [{ type: "inputText", text: "not executed" }], success: false });
});
