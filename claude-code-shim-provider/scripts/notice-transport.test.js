import { describe, expect, test } from "bun:test";
import { cleanNotices } from "./notice-transport.js";

const call = (id, name = "__shim_notice__") => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] });
const notice = { role: "user", content: "<system_notice>This tool call returned an error. Retry.</system_notice>" };

describe("cleanNotices", () => {
  test("drops the fake call, its error result and Vellum's follow-up system_notice", () => {
    const out = cleanNotices([
      { role: "user", content: "hi" },
      call("call_shim_notice_1"), { role: "tool", tool_call_id: "call_shim_notice_1", content: "[ERROR] Unknown tool" }, notice,
      { role: "assistant", content: "ok" },
    ]);
    expect(out.map((m) => m.content)).toEqual(["hi", "ok"]);
  });
  test("renumbers _vellum indexes after dropping notice messages", () => {
    const vellum = { version: 1, messages: [{ index: 0, source_ids: ["u0"] }, { index: 1, source_ids: ["a1"] }, { index: 3, source_ids: ["u3"] }] };
    const out = cleanNotices([{ role: "user", content: "hi" }, call("call_shim_notice_9"), { role: "tool", tool_call_id: "call_shim_notice_9", content: "e" }, { role: "user", content: "next" }], vellum);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
    expect(vellum.messages).toEqual([{ index: 0, source_ids: ["u0"] }, { index: 1, source_ids: ["u3"] }]);
  });
  test("keeps a system_notice that follows a real tool error", () => {
    const out = cleanNotices([call("toolu_1", "bash"), { role: "tool", tool_call_id: "toolu_1", content: "[ERROR] boom" }, notice]);
    expect(out.length).toBe(3);
  });
  test("keeps a user message that merely starts with a notice", () => {
    const mixed = { role: "user", content: "<system_notice>x</system_notice>\nреальный текст" };
    const out = cleanNotices([call("call_shim_notice_2"), { role: "tool", tool_call_id: "call_shim_notice_2", content: "e" }, mixed]);
    expect(out).toEqual([mixed]);
  });
});
