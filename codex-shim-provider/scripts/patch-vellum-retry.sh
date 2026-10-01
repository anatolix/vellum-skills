#!/usr/bin/env bash
# Optional shared Vellum patch. Never patch or restart the Claude shim here.
# Re-run after Vellum upgrades; restart your Vellum daemon only when no turn is active.
set -euo pipefail
F="${1:-$HOME/.bun/install/global/node_modules/@vellumai/assistant/src/providers/retry.ts}"
python3 - "$F" <<'PYCODE'
from pathlib import Path
import os, re, shutil, sys, tempfile
p = Path(sys.argv[1])
source = p.read_text()
updated = source
header = '''  // [local patch: codex-shim] Expose the conversation id to openai-compatible
  // shims as a header so they can resume a per-conversation upstream session.
  if (
    providerName === "openai-compatible" &&
    typeof config.conversationId === "string" &&
    config.conversationId.length > 0
  ) {
    nextConfig.requestHeaders = {
      ...(nextConfig.requestHeaders ?? {}),
      "X-Conversation-Id": config.conversationId,
    };
  }

'''
if '"X-Conversation-Id": config.conversationId' not in source:
    anchor = 'providerName === "opencode"'
    if source.count(anchor) != 1:
        sys.exit("Expected one opencode anchor; inspect the new Vellum version before patching")
    i = source.index(anchor)
    j = source.find('\n  }\n', i)
    if j < 0:
        sys.exit("End of opencode block not found; refusing to modify retry.ts")
    j += len('\n  }\n')
    updated = source[:j] + '\n' + header + source[j:]
match = re.search(r'const EFFORT_SUPPORTED_PROVIDERS = new Set\(\[(.*?)\]\);', updated, re.S)
if not match:
    sys.exit("EFFORT_SUPPORTED_PROVIDERS not found; refusing to modify retry.ts")
if not re.search(r'[\"\']openai-compatible[\"\']', match.group(1)):
    i = match.start(1)
    updated = updated[:i] + '\n  "openai-compatible", // [local patch: codex-shim]' + updated[i:]
if updated == source:
    print("already patched:", p)
    sys.exit(0)
backup = p.with_name(p.name + '.bak-conv-header')
if not backup.exists():
    shutil.copy2(p, backup)
fd, tmp = tempfile.mkstemp(prefix=p.name + '.', dir=p.parent)
try:
    with os.fdopen(fd, 'w') as f:
        f.write(updated)
    os.chmod(tmp, p.stat().st_mode & 0o777)
    os.replace(tmp, p)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
print("patched:", p, "backup:", backup)
PYCODE
