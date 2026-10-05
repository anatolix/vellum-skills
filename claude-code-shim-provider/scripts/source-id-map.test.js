import { describe, expect, test } from "bun:test";
import { attachSourceIds, replyIdOf, rowOf, partOf, SourceIdMap, NULL_SOURCE_ID_MAP, describeClasses, assistantBlocksOf, idCoverage } from "./source-id-map.js";

const blk = (text, ...sourceIds) => ({ kind: "user", text, sourceIds: sourceIds.length ? sourceIds : null });
const h = (b) => "h:" + b.text;

describe("attachSourceIds", () => {
  test("annotates messages by wire index, ignores junk", () => {
    const msgs = [{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "tool" }];
    const n = attachSourceIds(msgs, { version: 1, messages: [{ index: 1, source_ids: ["u1"] }, { index: 3, source_ids: ["u2"] }, { index: 9, source_ids: ["x"] }, { index: 2, source_ids: [] }] });
    expect(n).toBe(2);
    expect(msgs[0]._sourceIds).toBeUndefined();
    expect(msgs[1]._sourceIds).toEqual(["u1"]);
    expect(msgs[2]._sourceIds).toBeUndefined();
    expect(msgs[3]._sourceIds).toEqual(["u2"]);
  });
  test("no-op without _vellum or on wrong version", () => {
    const msgs = [{ role: "user" }];
    expect(attachSourceIds(msgs, undefined)).toBe(0);
    expect(attachSourceIds(msgs, { version: 4, messages: [{ index: 0, source_ids: ["a"] }] })).toBe(0);
    expect(attachSourceIds([{ role: "tool" }], { version: 2, messages: [{ index: 0, source_ids: ["row/call_1"] }] })).toBe(1);
    expect(attachSourceIds([{ role: "tool" }], { version: 3, reply_id: "r9", messages: [{ index: 0, source_ids: ["row/call_1"] }] })).toBe(1);
    expect(msgs[0]._sourceIds).toBeUndefined();
  });

  test("reply_id only on v3+; row/part split", () => {
    expect(replyIdOf({ version: 3, reply_id: "r9", messages: [] })).toBe("r9");
    expect(replyIdOf({ version: 3, messages: [] })).toBe(null);
    expect(replyIdOf({ version: 2, reply_id: "r9", messages: [] })).toBe(null);
    expect(replyIdOf(undefined)).toBe(null);
    expect(rowOf("row/toolu_1")).toBe("row"); expect(partOf("row/toolu_1")).toBe("toolu_1");
    expect(rowOf("row")).toBe("row"); expect(partOf("row")).toBe(null);
  });
});

describe("SourceIdMap", () => {
  test("new -> seen -> rewritten -> seen again; unknown without ids", () => {
    const m = new SourceIdMap(":memory:");
    const a = blk("hello", "u1"), b = blk("world", "u2"), noid = blk("plain");
    expect(m.classifyAll([a, b, noid], [h(a), h(b), h(noid)])).toEqual(["new", "new", "unknown"]);
    m.markFed([a, b], [h(a), h(b)]);
    expect(m.classify(a, h(a))).toBe("seen");
    const a2 = blk("hello (rendered differently)", "u1");
    expect(m.classify(a2, h(a2))).toBe("rewritten");
    m.markFed([a2], [h(a2)]);
    expect(m.classify(a2, h(a2))).toBe("seen");
    expect(m.classify(a, h(a))).toBe("seen"); // old rendering still known
    expect(m.stats()).toMatchObject({ ids: 2, rows: 3 });
    m.reset();
    expect(m.classify(a, h(a))).toBe("new");
    m.close();
  });
  test("merged block: all ids known -> seen/rewritten, any unknown id -> new", () => {
    const m = new SourceIdMap(":memory:");
    const a = blk("A", "u1"), b = blk("B", "u2");
    m.markFed([a, b], [h(a), h(b)]);
    const merged = blk("A\n\nB", "u1", "u2");
    expect(m.classify(merged, h(merged))).toBe("rewritten");
    const mergedNew = blk("A\n\nC", "u1", "u3");
    expect(m.classify(mergedNew, h(mergedNew))).toBe("new");
    m.close();
  });
  test("persists to a file and reopens", () => {
    const path = `/tmp/source-id-map-test-${process.pid}.sqlite`;
    const m1 = new SourceIdMap(path);
    const a = blk("persisted", "u9");
    m1.markFed([a], [h(a)]);
    m1.close();
    const m2 = new SourceIdMap(path);
    expect(m2.classify(a, h(a))).toBe("seen");
    m2.close();
    for (const suf of ["", "-wal", "-shm"]) { try { require("node:fs").unlinkSync(path + suf); } catch {} }
  });
});

describe("describeClasses", () => {
  test("null when nothing carried ids", () => {
    expect(describeClasses(["unknown", "unknown"])).toBeNull();
    expect(describeClasses(["seen", "rewritten", "new", "unknown"])).toBe("ids: seen=1 rewritten=1 new=1 noid=1");
  });
});

describe("assistantBlocksOf", () => {
  test("keeps assistant text and tool calls with their ids, skips other roles and empties", () => {
    const msgs = [
      { role: "user", content: "hi", _sourceIds: ["u1"] },
      { role: "assistant", content: "hello", _sourceIds: ["a1"] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "bash" } }], _sourceIds: ["a2"] },
      { role: "assistant", content: "" },
      { role: "tool", tool_call_id: "c1", content: "ok", _sourceIds: ["a2"] },
    ];
    const b = assistantBlocksOf(msgs);
    expect(b.map(x => x.sourceIds)).toEqual([["a1"], ["a2"]]);
    expect(b.every(x => x.kind === "assistant")).toBe(true);
    expect(b[1].id).toBe("c1:bash");
  });
  test("assistant ids land in the map", () => {
    const map = new SourceIdMap(":memory:");
    const b = assistantBlocksOf([{ role: "assistant", content: "x", _sourceIds: ["a1"] }]);
    map.markFed(b, ["h"]);
    expect(map.classify(b[0], "h")).toBe("seen");
    map.close();
  });
});

describe("idCoverage", () => {
  test("null summary when every non-system message has ids", () => {
    const c = idCoverage([{ role: "system" }, { role: "user", _sourceIds: ["u"] }, { role: "assistant", _sourceIds: ["a"] }]);
    expect(c.summary).toBe(null);
    expect(c.missing).toBe(0);
  });
  test("reports partial gaps per role, not just all-or-nothing", () => {
    const c = idCoverage([
      { role: "user", _sourceIds: ["u1"] }, { role: "assistant" },
      { role: "tool", _sourceIds: ["a"] }, { role: "user" },
    ]);
    expect(c.missing).toBe(2);
    expect(c.summary).toBe("2 из 4 (user 1, assistant 1)");
    expect(c.none).toBe(false);
    expect(c.details.map((d) => d.index)).toEqual([1, 3]);
  });
});

describe("idCoverage synthetic rows", () => {
  test("compaction summary is not counted", () => {
    const c = idCoverage([
      { role: "assistant", content: "<context_summary>\n…" },
      { role: "assistant", text: "Assistant: <context_summary> x" },
      { role: "user", _sourceIds: ["u"] },
    ]);
    expect(c.missing).toBe(0);
    expect(c.summary).toBe(null);
  });
});

describe("cli_ids (patch 9)", () => {
  test("claude reply: text + tool_use recorded under the reply row, result marks the call fed", () => {
    const m = new SourceIdMap(":memory:");
    const n = m.recordClaudeAssistant("r1", { uuid: "u1", session_id: "s1", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_1", name: "bash", input: {} }] } });
    expect(n).toBe(2);
    expect(m.isPartFed("toolu_1")).toBe(false);
    m.recordResultFed(["res1/toolu_1"], "toolu_1");
    expect(m.isPartFed("toolu_1")).toBe(true);
    expect(m.isPartFed("toolu_2")).toBe(false);
    const rows = m.db.query("SELECT vellum_id, row_id, part, cli_id, kind, fed FROM cli_ids ORDER BY vellum_id").all();
    expect(rows).toEqual([
      { vellum_id: "r1", row_id: "r1", part: null, cli_id: "u1", kind: "reply", fed: 0 },
      { vellum_id: "r1/toolu_1", row_id: "r1", part: "toolu_1", cli_id: "u1", kind: "tool_use", fed: 1 },
      { vellum_id: "res1/toolu_1", row_id: "res1", part: "toolu_1", cli_id: "", kind: "tool_result", fed: 1 },
    ]);
    expect(m.stats().cli).toEqual({ n: 3, calls: 1, fed: 1 });
    m.close();
  });

  test("result without ids lands under ?/<id>; reset wipes; null map is inert", () => {
    const m = new SourceIdMap(":memory:");
    m.recordCli("r2/call_a", "rpc:7", "tool_use", { part: "call_a" });
    m.recordResultFed(null, "call_a");
    expect(m.db.query("SELECT vellum_id FROM cli_ids WHERE kind = 'tool_result'").get()).toEqual({ vellum_id: "?/call_a" });
    expect(m.isPartFed("call_a")).toBe(true);
    m.reset();
    expect(m.isPartFed("call_a")).toBe(false);
    m.close();
    expect(NULL_SOURCE_ID_MAP.recordClaudeAssistant("r", {})).toBe(0);
    expect(NULL_SOURCE_ID_MAP.recordUserFed([{ sourceIds: ["u"] }], "x")).toBe(0);
  });

  test("fed user blocks pair every source id with the CLI entry id", () => {
    const m = new SourceIdMap(":memory:");
    expect(m.recordUserFed([{ sourceIds: ["u1"] }, { sourceIds: ["u2/tail", "u3"] }, { sourceIds: null }], "uuid-9", "s1")).toBe(3);
    expect(m.db.query("SELECT vellum_id, part, cli_id, kind, fed FROM cli_ids ORDER BY vellum_id").all()).toEqual([
      { vellum_id: "u1", part: null, cli_id: "uuid-9", kind: "user", fed: 1 },
      { vellum_id: "u2/tail", part: "tail", cli_id: "uuid-9", kind: "user", fed: 1 },
      { vellum_id: "u3", part: null, cli_id: "uuid-9", kind: "user", fed: 1 },
    ]);
    m.close();
    expect(NULL_SOURCE_ID_MAP.isPartFed("x")).toBe(false);
  });
});

describe("id coverage fixes (Oct 5)", () => {
  const fresh = () => new SourceIdMap(":memory:");
  test("thinking blocks recorded with their own uuid", () => {
    const m = fresh();
    expect(m.recordClaudeAssistant("r1", { uuid: "t1", session_id: "s", message: { content: [{ type: "thinking", thinking: "x" }] } })).toBe(1);
    expect(m.db.query("SELECT kind, cli_id FROM cli_ids").all()).toEqual([{ kind: "thinking", cli_id: "t1" }]);
  });
  test("fillResultCli fills only empty tool_result rows", () => {
    const m = fresh();
    m.recordResultFed(["row/toolu_1"], "toolu_1");
    expect(m.fillResultCli(new Map([["toolu_1", "uuid-res"]]))).toBe(1);
    expect(m.db.query("SELECT cli_id FROM cli_ids WHERE kind='tool_result'").get().cli_id).toBe("uuid-res");
  });
  test("reconcileEmpty: Codex inherits call item id, reports leftovers once", () => {
    const m = fresh();
    m.recordCli("reply/call_a", "item-1", "tool_use", { part: "call_a" });
    m.recordResultFed(["res/call_a"], "call_a");
    m.recordCli("user1", "", "user", { fed: 1 });
    const now = Date.now() + 60_000;
    const r = m.reconcileEmpty({ fromCall: true, now });
    expect(r.found.map(x => x.cli_id)).toEqual(["item-1"]);
    expect(r.left.map(x => x.vellum_id)).toEqual(["user1"]);
    expect(m.reconcileEmpty({ fromCall: true, now })).toBe(null);
  });
  test("reconcileEmpty skips rows younger than minAgeMs", () => {
    const m = fresh();
    m.recordResultFed(["res/toolu_9"], "toolu_9");
    expect(m.reconcileEmpty({ byToolId: new Map([["toolu_9", "u"]]) })).toBe(null);
  });
  test("missingGrew fires only on increase", () => {
    const m = fresh();
    expect([m.missingGrew(2), m.missingGrew(2), m.missingGrew(3), m.missingGrew(1), m.missingGrew(1), m.missingGrew(2)]).toEqual([true, false, true, false, false, true]);
  });
});
