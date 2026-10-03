# Setup and deployment

Verified baseline: Linux x86-64, Codex 0.159.3, Bun and Python 3. No npm runtime dependencies for the shim. Verify newer protocol versions locally before upgrading. These commands assume the current directory is the installed skill directory.

## 1. Inspect before installing

Check existing inference connections/profiles, `systemctl --user list-units '*shim*'`, and `ss -lntp`. Keep Claude's listener, state and unit unchanged. Defaults here use `~/codex-shim`, `codex-shim.service`, `codex-chatgpt` and port 8321. If already present, inspect and update rather than creating duplicates.

## 2. Install a native Codex binary on a Bun-only VM

```bash
bun add -g @openai/codex@0.159.3
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" "$HOME/.local/bin/codex"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
codex --version
```

This symlink is for Linux x86-64. Other architectures/package layouts need their actual native binary path. The npm entrypoint uses Node; invoking the native binary avoids that dependency. Do not overwrite a separately managed existing binary blindly.

## 3. ChatGPT OAuth device login

```bash
codex login --device-auth
```

The user opens the URL printed by Codex and enters its short-lived code. Keep a headless login process alive while they authenticate. Credentials live under `~/.codex/`; do not print, copy into this skill or commit them. Prefer `codex login status`; if the installed wrapper fails, diagnose the native binary and inspect only non-secret auth metadata, not tokens.

## 4. Deploy the separate service

Do not replace files while a turn is in flight. Back up a previous deployment and wait for matching `[req]` / `[res]` in its journal first.

```bash
mkdir -p "$HOME/codex-shim" "$HOME/.config/systemd/user"
cp scripts/server-v2.js scripts/notice-transport.js scripts/server.js scripts/run.sh "$HOME/codex-shim/"
chmod +x "$HOME/codex-shim/run.sh"
cp scripts/codex-shim.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now codex-shim.service
journalctl --user -u codex-shim.service -n 30 --no-pager
```

`enable --now` does not reload an already-running service after a code update. Explicitly restart **codex-shim.service only**, after the active turn finishes. The unit intentionally has no machine-specific Vellum/Claude dependency.

Use a systemd drop-in for overrides:

```ini
[Service]
Environment=SHIM_PORT=8321
Environment=SHIM_DEFAULT_EFFORT=high
Environment=SHIM_REASONING_SUMMARY=detailed
Environment=SHIM_MAX_FEED=8
```

Diagnostics: `SHIM_DEBUG=1`; normal defaults keep verbose per-event content logging off. Logs and session files are private.

## 5. Add the Vellum patches (conversation header, effort)

Vellum versions that omit `prompt_cache_key` for `openai-compatible` need an explicit conversation header. Check live outgoing requests first. The shim deliberately returns 400 for background probes/jobs with no chat identity.

```bash
bash scripts/patch-vellum-retry.sh   "$HOME/.bun/install/global/node_modules/@vellumai/assistant/src/providers/retry.ts"
```

Effort needs three more Vellum changes, shipped as one git patch against 0.12.6 in `patches/vellum-0.12.6-openai-compatible-effort.patch`: `retry.ts` adds `openai-compatible` to `EFFORT_SUPPORTED_PROVIDERS` (otherwise `effort` is stripped before the client), `adapter-factory.ts` sets `maxReasoningEffort: "max"` for `openai-compatible` (default ceiling `xhigh` silently rewrote `max`), and the web `profile-param-visibility.ts` shows the effort control for `openai-compatible` profiles (needs a web rebuild from the patched checkout and a copy of `dist/` into the runtime). Apply with `git apply` in a source checkout, or edit the runtime `src/` files by hand; the retry.ts hunk is also applied by `patch-vellum-retry.sh`. Verify on the wire: shim journal `[effort] model=… requested=max effective=max`.

The header/effort script is independently idempotent for its two hunks, writes only after both anchors validate, and keeps a `.bak-conv-header` backup. Review the actual `retry.ts` diff. It preserves other provider patches and existing headers, but is shared infrastructure: re-check the Claude provider after application. Restart **your actual Vellum daemon** once its current turn completes; discover its unit name rather than copying a machine-specific name. Re-apply after upgrades if upstream still needs it. Do not blindly restore an old entire-file backup over newer upstream changes.

## 6. Quota-free smoke checks

```bash
curl -fsS http://127.0.0.1:8321/v1/models
curl -s -o /tmp/codex-keyless.json -w '%{http_code}\n'   -H 'Content-Type: application/json'   http://127.0.0.1:8321/v1/chat/completions   -d '{"messages":[{"role":"user","content":"do not run"}]}'
cat /tmp/codex-keyless.json
```

Expected: models JSON, then **400** with `missing_session_key`, no thread/turn creation. `/v1/models` queries the local app-server model list, not model inference. Keep all credentials out of commands/chat.

## 7. Register a new Vellum connection and profiles

Fetch model IDs live; availability depends on the authenticated account. The following is a template, not a frozen catalog:

```bash
MODEL='<id returned by /v1/models>'
assistant inference providers create codex-chatgpt --provider openai-compatible   --auth none --base-url http://127.0.0.1:8321/v1 --model "$MODEL"
assistant inference profiles create "codex-$MODEL" --provider openai-compatible   --connection codex-chatgpt --model "$MODEL" --label "ChatGPT ($MODEL)"   --effort high --allow-unlisted
```

`--model` is repeatable on provider creation; include the available IDs you actually want. Use the CLI's provider `update` command for an existing connection, not `patch`. Registration may issue a probe; with no chat ID, strict mode intentionally rejects it instead of burning quota. Do not enable keyless mode to make probes succeed. A real end-to-end test must be a named conversation or an explicit stable `prompt_cache_key`; it consumes model quota and is separate from packaging tests.

## 8. Verify a dynamic tool round trip when requested

Send a chat request with a stable session key, a user prompt and an OpenAI function definition. Expect `finish_reason: "tool_calls"`. Send the complete subsequent conversation, including its assistant tool-call block and matching `role: "tool"` result, under the same key and unchanged tool definitions. Expect the paused turn to resume without another `thread/start` or `thread/resume`. Tests cover this with a fake app-server; use a real model only for an authorized smoke test.

v1 fallback: set `SHIM_SERVER=server.js` in a drop-in and restart the Codex unit deliberately. v1 has no v2 streaming/dynamic-tools/strict-key/guard/thinking-fallback guarantees; it is not an automatic failover.
