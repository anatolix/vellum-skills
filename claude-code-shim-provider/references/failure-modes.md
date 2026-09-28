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

## Model fabricates tool results and "continues" (DANGEROUS)
**Symptom:** reply contains `<tool_result name="...">` blocks written by the model itself, followed by a confident analysis. Files/tables it "read" may not exist.
**Cause:** with `maxTurns: 1` and a text contract, nothing physically stops the model from writing a fake result and going on. Triggered when a TOOL_CALL line failed to parse (e.g. glued to previous text on the same line) — the model then invented what the tool "returned".
**Fix (in server.js):** output is truncated at the first model-written `<tool_result`; everything after the first parsed TOOL_CALL is discarded; regex no longer anchored at line start; contract says "STOP after TOOL_CALL, never write <tool_result>". If the whole output was fabricated, the shim returns a visible `[shim] ...` notice instead of an empty reply.
**Rule for the human:** any Claude-Code-profile answer citing file paths or numbers should be spot-checked (`ls`, `sqlite3`) before acting on it.

## Shim log: `Failed to authenticate. API Error: 401 OAuth access token has expired`
**Cause:** the token came from the inline ACP "Connect Claude Code" card — a short-lived session token (~10 h), not a long-lived one.
**Fix:** re-issue with `claude setup-token` (1-year token) as described in SKILL.md step 2, store in vault, restart claude-shim. Do not use the ACP card token for the shim.

## `claude setup-token` ignores Enter after pasting the code
**Cause:** the Ink TUI switches the terminal to kitty keyboard protocol; tmux's `Enter` (`\r`) is sometimes not accepted.
**Fix:** `tmux send-keys -t st -l $'\e[13u'` (kitty-encoded Enter). Token then prints to the pane/pipe-pane log.

## Valid TOOL_CALL lands in chat as text; log says `fabricated <tool_result>; output truncated`
**Cause:** (fixed Sep 26) the fabrication guard was global and cut a TOOL_CALL whose JSON *mentioned* `<tool_result`.
**Fix:** current server.js checks per line, only on non-TOOL_CALL lines. If you see this with the current code, check `[warn] unparsable TOOL_CALL line: <reason>` in the log — the JSON itself was broken.

## Chat shows raw `<invoke name="bash"><parameter …>` blocks, several in a row
**Cause:** on a long history (80+ msgs) Opus drifts from the TOOL_CALL contract back to Anthropic-native `<invoke>` XML, and writes several calls blind, without waiting for results. Log: `[req]` with no matching `[res]`.
**Fix (Sep 26):** `parseInvoke()` fallback converts the FIRST `<invoke>` into a real tool_call (typed params coerced via the tool schema), drops the rest; contract forbids `<invoke>` XML. Log: `[warn] model used <invoke> XML instead of TOOL_CALL; took 1 of N`.

## `[req] … key=-` on every request; `/chats` empty; all work goes through ephemeral processes
**Cause:** Vellum did not send `prompt_cache_key` — local patch 239cd4af not applied after an upgrade, or daemon not restarted.
**Fix:** re-apply `local-patches`, `systemctl --user restart vellum-<name>.service`.

## `[sess] … spawn blocks=<whole history>` on a chat that was live a minute ago
**Cause:** resume failed (session file lost, `~/.claude/projects` cleaned, CLI upgraded) or Vellum rewrote earlier messages so no hash prefix matched.
**Fix:** nothing — the fresh process gets the full history and continues; only the cache hit for that one request is lost. If it repeats every request, look for `[sess] … resume failed: …` in the log.

## `recall` via MCP → «Tool execution timed out after 120s»
**Cause:** Vellum's default tool timeout; recall on a slow background model takes longer.
**Fix:** `VELLUM_MCP_TOOL_TIMEOUT_SEC=300` in the MCP server env (Richard: `mcp_servers.json`). Log line at start shows `toolTimeout=300s`.

## Richard wrapper: `401 Missing API key`
**Cause:** your curl has no `Authorization` header. Vellum always sends `Bearer …` even with `--auth none`, so real profiles are fine.
**Fix:** add `-H 'Authorization: Bearer x'` to the test.
