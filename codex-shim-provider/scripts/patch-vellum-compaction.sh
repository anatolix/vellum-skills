#!/usr/bin/env bash
# Local Vellum patch for shim-side compaction (codex-shim / claude-shim). Idempotent; re-run after upgrades.
#  1) context/compactor.ts: the compaction summary call carries selectionSeed+conversationId, so
#     openai-compatible providers get prompt_cache_key = conversation id (session affinity).
#  2) providers/retry.ts: openai-compatible requests carry X-Call-Site (and X-Conversation-Id) headers,
#     for session affinity/diagnostics. X-Call-Site remains mainAgent for cache/profile routing.
#  3) compactor.ts: X-Shim-Operation: compact explicitly identifies internal compaction calls.
# Restart the Vellum daemon afterwards (only when no turn is active).
set -euo pipefail
SRC="${1:-$HOME/.local/share/vellum/assistants/juno/.vellum/runtime/0.12.6/node_modules/@vellumai/assistant/src}"
python3 - "$SRC" <<'PYCODE'
import sys, shutil, time
from pathlib import Path
src = Path(sys.argv[1]); stamp = time.strftime("%Y%m%d-%H%M%S")
def apply(path, old, new, count):
    s = path.read_text()
    marker = next(l for l in new.splitlines() if "[local patch: codex-shim]" in l).strip()
    if marker in s: print("already patched:", path.name); return
    assert s.count(old) == count, f"{path}: expected {count} anchor(s), found {s.count(old)}"
    shutil.copy2(path, path.with_name(path.name + f".bak-compaction-{stamp}"))
    path.write_text(s.replace(old, new)); print("patched:", path.name)
apply(src / "context/compactor.ts",
'''      config: {
        callSite: COMPACTION_CALL_SITE,
        usageTracking: "manual",''',
'''      config: {
        callSite: COMPACTION_CALL_SITE,
        // [local patch: codex-shim] session affinity for shim providers: prompt_cache_key /
        // X-Conversation-Id must name the same conversation as the main turns.
        selectionSeed: args.conversationId,
        conversationId: args.conversationId,
        usageTracking: "manual",''', 2)
apply(src / "providers/retry.ts",
'''    const headers = resolveFireworksRequestHeaders(sessionKey);
    if (Object.keys(headers).length > 0) {
      nextConfig.requestHeaders = headers;
    }
  }
''',
'''    const headers = resolveFireworksRequestHeaders(sessionKey);
    if (Object.keys(headers).length > 0) {
      nextConfig.requestHeaders = headers;
    }
  }

  // [local patch: codex-shim] openai-compatible shims learn the call-site (compactionAgent →
  // compact the shim's own session instead of running a normal turn) and the conversation id.
  if (providerName === "openai-compatible") {
    const extra: Record<string, string> = {};
    if (typeof config.callSite === "string" && config.callSite.length > 0) {
      extra["X-Call-Site"] = config.callSite;
    }
    if (typeof config.conversationId === "string" && config.conversationId.length > 0) {
      extra["X-Conversation-Id"] = config.conversationId;
    }
    if (Object.keys(extra).length > 0) {
      nextConfig.requestHeaders = {
        ...((nextConfig.requestHeaders as Record<string, string> | undefined) ?? {}),
        ...extra,
      };
    }
  }
''', 1)
# Explicit intent survives reasoning adapters dropping tool_choice and keeps mainAgent routing.
apply(src / "context/compactor.ts",
'''        callSite: COMPACTION_CALL_SITE,
''',
'''        callSite: COMPACTION_CALL_SITE,
        // [local patch: codex-shim] operation intent independent of mainAgent routing.
        requestHeaders: { "X-Shim-Operation": "compact" },
''', 2)
PYCODE
