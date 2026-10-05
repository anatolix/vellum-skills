import { describe, expect, test } from "bun:test";
import { attachSourceIds, SourceIdMap, describeClasses, assistantBlocksOf, idCoverage } from "./source-id-map.js";

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
    expect(attachSourceIds(msgs, { version: 2, messages: [{ index: 0, source_ids: ["a"] }] })).toBe(0);
    expect(msgs[0]._sourceIds).toBeUndefined();
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
    expect(m.stats()).toEqual({ ids: 2, rows: 3 });
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
