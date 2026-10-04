import { describe, expect, test } from "bun:test";
import {
  buildNativeSafeModelCatalog,
  failClosedApprovalResponse,
} from "./native-tool-policy.js";

describe("native-safe model catalog", () => {
  test("removes apply_patch from every model without changing other capabilities", () => {
    const source = {
      etag: "x",
      models: [
        { slug: "a", apply_patch_tool_type: "freeform", input_modalities: ["text", "image"] },
        { slug: "b", apply_patch_tool_type: null, extra: true },
      ],
    };
    const safe = buildNativeSafeModelCatalog(source);
    expect(safe.etag).toBe("x");
    expect(safe.models.map(model => model.apply_patch_tool_type)).toEqual([null, null]);
    expect(safe.models[0].input_modalities).toEqual(["text", "image"]);
    expect(safe.models[1].extra).toBe(true);
    expect(source.models[0].apply_patch_tool_type).toBe("freeform");
  });

  test("fails closed without a usable model catalog", () => {
    expect(() => buildNativeSafeModelCatalog({ models: [] })).toThrow();
    expect(() => buildNativeSafeModelCatalog({})).toThrow();
  });
});

describe("native approval RPCs", () => {
  test("declines v2 command and file approvals", () => {
    expect(failClosedApprovalResponse("item/commandExecution/requestApproval")).toEqual({ decision: "decline" });
    expect(failClosedApprovalResponse("item/fileChange/requestApproval")).toEqual({ decision: "decline" });
  });

  test("grants no additional permissions", () => {
    expect(failClosedApprovalResponse("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
      strictAutoReview: false,
    });
  });

  test("denies legacy approvals with the legacy ReviewDecision shape", () => {
    for (const method of ["applyPatchApproval", "execCommandApproval"]) {
      expect(failClosedApprovalResponse(method)).toEqual({
        decision: {
          denied: {
            rejection: "Native Codex approvals are disabled by the shim; use a Vellum-gated tool instead.",
          },
        },
      });
    }
  });

  test("unknown approval RPCs fail closed; unrelated requests are untouched", () => {
    expect(() => failClosedApprovalResponse("item/newThing/requestApproval")).toThrow();
    expect(failClosedApprovalResponse("currentTime/read")).toBeUndefined();
  });
});
