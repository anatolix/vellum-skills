#!/usr/bin/env python3
"""Shared retry.ts patch regressions on fixtures only; no real Vellum edits."""
from pathlib import Path
import os
import subprocess
import tempfile

PATCH = Path(__file__).resolve().parent.parent / 'scripts/patch-vellum-retry.sh'
SOURCE = '''const EFFORT_SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
]);
function configure(providerName, config) {
  const nextConfig = {...config};
  // existing independent Claude patch: preserve this block byte-for-byte
  if (providerName === "anthropic") {
    nextConfig.anthropicOnly = true;
  }
  if (providerName === "opencode") {
    nextConfig.requestHeaders = resolveOpenCodeRequestHeaders(config.conversationId);
  }
  return nextConfig;
}
'''
CLAUDE = SOURCE[SOURCE.index('  // existing'):SOURCE.index('  if (providerName === "opencode")')]


def main():
    passed = 0
    with tempfile.TemporaryDirectory(prefix='codex-patch-test-') as tmp:
        root = Path(tmp)
        def run(text, name, *, default=False):
            p = root / name / 'retry.ts'
            if default:
                p = root / name / '.bun/install/global/node_modules/@vellumai/assistant/src/providers/retry.ts'
            p.parent.mkdir(parents=True)
            p.write_text(text)
            p.chmod(0o640)
            env = {**os.environ, 'HOME': str(root / name)}
            result = subprocess.run(['bash', str(PATCH), *([] if default else [str(p)])],
                                    env=env, capture_output=True, text=True)
            return p, result

        def check(name):
            nonlocal passed
            passed += 1
            print('PASS', name)

        p, result = run(SOURCE, 'fresh')
        assert result.returncode == 0, result.stderr
        fresh = p.read_text()
        assert '"X-Conversation-Id": config.conversationId' in fresh
        assert fresh.count('"openai-compatible", // [local patch: codex-shim]') == 1
        assert CLAUDE in fresh and '...(nextConfig.requestHeaders ?? {})' in fresh
        assert (p.stat().st_mode & 0o777) == 0o640
        backup = p.with_name('retry.ts.bak-conv-header')
        assert backup.read_text() == SOURCE
        check('both-hunks-preserve-existing-claude-patch-and-file-mode')

        result = subprocess.run(['bash', str(PATCH), str(p)], capture_output=True, text=True)
        assert result.returncode == 0 and p.read_text() == fresh
        assert backup.read_text() == SOURCE
        check('idempotent-with-original-backup')

        header_only = fresh.replace('  "openai-compatible", // [local patch: codex-shim]\n', '')
        p, result = run(header_only, 'header-only')
        assert result.returncode == 0, result.stderr
        text = p.read_text()
        assert text.count('"X-Conversation-Id": config.conversationId') == 1
        assert '"openai-compatible", // [local patch: codex-shim]' in text
        check('repairs-header-only-patch')

        effort_only = SOURCE.replace('  "anthropic",', '  "openai-compatible", // [local patch: codex-shim]\n  "anthropic",')
        p, result = run(effort_only, 'effort-only')
        assert result.returncode == 0, result.stderr
        text = p.read_text()
        assert text.count('"openai-compatible", // [local patch: codex-shim]') == 1
        assert '"X-Conversation-Id": config.conversationId' in text
        check('repairs-effort-only-patch')

        for name, text in [('missing-opencode', SOURCE.replace('"opencode"', '"changed"')),
                           ('missing-effort', SOURCE.replace('EFFORT_SUPPORTED_PROVIDERS', 'CHANGED_SET'))]:
            p, result = run(text, name)
            assert result.returncode != 0 and p.read_text() == text
            assert not p.with_name('retry.ts.bak-conv-header').exists()
            check(name + '-fails-without-writing')

        p, result = run(SOURCE, 'portable-home', default=True)
        assert result.returncode == 0, result.stderr
        assert '"X-Conversation-Id": config.conversationId' in p.read_text()
        check('portable-home-default')

    print(str(passed) + ' tests passed; real Vellum and Claude untouched.')


if __name__ == '__main__':
    main()
