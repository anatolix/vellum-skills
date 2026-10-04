import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LEGACY_DENIAL_REASON =
  "Native Codex approvals are disabled by the shim; use a Vellum-gated tool instead.";

export function buildNativeSafeModelCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("Codex model catalog is missing a non-empty models array");
  }
  return {
    ...catalog,
    models: catalog.models.map(model => ({
      ...model,
      // Codex registers apply_patch whenever this model-catalog field is non-null.
      apply_patch_tool_type: null,
    })),
  };
}

export function prepareNativeSafeModelCatalog({ sourcePath, targetPath }) {
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const safe = buildNativeSafeModelCatalog(source);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, targetPath);
  chmodSync(targetPath, 0o600);
  return targetPath;
}

export function failClosedApprovalResponse(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      // This RPC has no explicit decline variant. Granting an empty profile is
      // the protocol-valid fail-closed response.
      return { permissions: {}, scope: "turn", strictAutoReview: false };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: { denied: { rejection: LEGACY_DENIAL_REASON } } };
    default:
      if (method?.endsWith("requestApproval")) {
        throw new Error(`Unsupported native approval RPC denied: ${method}`);
      }
      return undefined;
  }
}
