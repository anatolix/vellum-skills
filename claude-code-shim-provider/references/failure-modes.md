# Failure modes

## ACP spawn fails: "ACP connection closed"
**Cause:** `claude-agent-acp` is a Node.js script — `/usr/bin/env: node: No such file or directory` when `node` is not on PATH (Bun-only system).
**Fix:** Install Node.js 22+: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

## SDK query returns "Not logged in · Please run /login"
**Cause 1:** `CLAUDE_CODE_OAUTH_TOKEN` not in process.env when SDK spawns child process.
**Fix:** Pass explicitly via `options.env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN }`.

**Cause 2:** systemd user service doesn't inherit `VELLUM_WORKSPACE_DIR`, so `assistant credentials reveal` fails silently → token_len=0.
**Fix:** Export `VELLUM_WORKSPACE_DIR`, `VELLUM_DATA_DIR`, `VELLUM_CLOUD=local`, `VELLUM_ENVIRONMENT=local` in the wrapper script.

## Provider registered but profile returns "Could not connect to the AI provider"
**Possible cause:** The shim server crashed between registration and use (systemd restarts). Check `systemctl --user status claude-shim.service`.
**Possible cause:** Active profile changed mid-conversation — the current chat session started on another model and the active switch only affects new sessions.

## OAuth flow: callback URL shows 404 on phone
Expected — the redirect goes to a loopback listener. Copy the full redirect URL (even though it fails to load) and paste back. I curl it into the local listener.

## Vellum session on Claude Code profile has no tools (text-only)
**Cause:** shim ignores `body.tools` and passes `tools: []` to the SDK — the model never sees tool definitions. Not a Vellum setting; there is no per-profile tool toggle.
**Fix:** use the tool-capable `server.js` from this skill (prompt contract → `TOOL_CALL:` lines → OpenAI `tool_calls` deltas). Verify with `scripts/test-shim.sh`.

## Model answers in text instead of emitting tool_calls
**Cause:** malformed `TOOL_CALL` line (not one-line JSON, wrapped in fences with extra prose). The parser drops unparsable lines into content.
**Fix:** check `journalctl --user -u claude-shim` — `[res] tool_calls=` line is absent. Usually transient; strengthen `TOOL_INSTRUCTIONS` if it recurs.

## No token streaming when tools are present
**Expected.** The reply is buffered to detect TOOL_CALL lines. Plain requests (no tools) still stream.
