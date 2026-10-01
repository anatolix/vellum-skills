
## 21. One-shot requests must not occupy chat slots (Sep 28 evening)
`assistant inference send` and batch scripts send a fresh `prompt_cache_key` per call. With
"one process per key" each call became a chat whose ~220 MB process sat in a `MAX_LIVE`
slot until the 1h TTL. A 4-thread resolve pipeline filled 7 of 8 slots with spent
processes within minutes. Fix: history with no `assistant`/`tool` turn → throwaway
process (`runEphemeral`, tag `oneshot`), closed after the answer, not counted in
`liveCount()`, separate `SHIM_MAX_ONESHOT` guard. A real chat's turn 2 respawns with the
full two-block history — one extra cache write, acceptable. Don't try to distinguish
"CLI one-shot" from "chat turn 1" by content — not reliable; the history shape is.

## 22. `pkill -f`/`pgrep -f` with a pattern that appears in your own command line kills the tool shell
Three bash calls died with exit code null in one evening because the pattern
(`SHIM_MAX_LIVE=2`, `bun run server.js`) matched the shell running the kill loop. Find
test instances by port: `ss -ltnp | grep ':8328 ' | grep -o 'pid=[0-9]*'`, kill by PID.
Start side instances from a script file so the env string isn't on your command line.

## 23. Thinking summaries need display:"summarized" — subscription thinking is redacted by default (Sep 28 night)
Claude models behind the subscription DO think (adaptive thinking is default on Opus 5.5 /
Sonnet 5; trivial prompts skip it — thinking_tokens 0 is correct, not a bug). But without
`thinking: { type: "adaptive", display: "summarized" }` the API returns redacted blocks:
empty `thinking` text + cryptographic signature, stream carries only `estimated_tokens`.
With `display: "summarized"` real summary text streams as `thinking_delta`. Shim forwards
those as OpenAI-style `delta.reasoning_content` — Vellum's chat-completions provider parses
that field into UI thinking (Together/DeepSeek convention; OpenRouter uses `reasoning`).
Raw chain-of-thought is never available on OAuth subscription traffic — summaries only.
Vellum sends NO reasoning_effort for claude-code-* profiles, so the shim defaults to
adaptive+summarized; "none" disables thinking. Interactive CLI equivalent: settings.json
`"showThinkingSummaries": true`.

## 24. Partial sed/python replaces: verify EVERY targeted line landed (Sep 28 night)
A python `s.replace(old,new,1)` that silently matched zero times left `Chat.run` without the
`effort` param while the body referenced it → runtime ReferenceError, one-shot path worked,
keyed chats 500. `bun build` does NOT catch undefined vars. After any scripted edit: grep
every intended anchor, and smoke-test BOTH the ephemeral and the keyed-chat path before
restart.

## 25. TOOL_CALL parsing must be multi-line and string-aware (Sep 30)

The original parser matched `TOOL_CALL: {...}` per line (`/\{.*\}\s*$/`). Fable wrote a bash heredoc into `"command"` with *literal* newlines inside the JSON string — invalid JSON, spanning many lines — and the regex never matched, so the whole call went to the user as text. Fix: find `TOOL_CALL:`, scan a balanced `{...}` with a quote/escape-aware brace counter (newlines inside strings do not terminate it), then `JSON.parse`; on failure escape raw `\n \r \t` inside string literals and retry. Also handles pretty-printed JSON, code-fence wrapping, and several calls in a row. Everything after the last parsed call is discarded, `<tool_result` fabrication guard applies to the text before the first call.


## Lesson 26 — salvage a TOOL_CALL whose JSON never closes

The text contract makes the model hand-escape JSON strings. On shell commands with nested quotes
(`python -c "..."`, `\"` inside `$( )`, regexes with `\\[`) Fable eventually drops or doubles one escape,
the string never closes, and the whole call used to leak into the chat as plain text. Native tool-use never
has this problem because the API, not the model, owns the escaping.

Fix (server.js `salvageToolCall`): when `scanJsonObject` gives up, or the balanced chunk fails to parse,
read `"name"`, then slice argument values between top-level `"<key>":` markers taken from the tool's own
schema (first key = first occurrence, later keys = last occurrence), decode each value leniently.
Also added to TOOL_INSTRUCTIONS: commands needing heavy quoting go through `file_write` + one-line `bash`.
Test harness: `scratch/shim-salvage-test.mjs` (4 cases, incl. healthy heredoc regression).

## 27. Native tool_use via an in-process MCP server — Vellum still executes (Sep 30)
The text contract was always a workaround. The Agent SDK accepts `mcpServers` built with
`createSdkMcpServer`, so the request's OpenAI `tools` become MCP tools the model calls
natively; the escaping problem (lessons 25–26) disappears because the API owns it. The
handler does NOT execute anything: it parks on a promise, the request layer returns
`tool_calls` to Vellum and ends the HTTP response, Vellum runs the tool with its own
approvals/trust, and the next request's `role: tool` resolves the handler. Spikes that made
it viable: a handler may hang 4+ min without the CLI complaining; abort+resume with an
open tool_use recovers; `q.setMcpServers` swaps tools on a live session. One thing that
does NOT work: sharing one server instance between two CLI processes — the second gets no
tools, no error. `make()` per spawn.

## 28. `init tools=0` with `vellum:connected` — one unconvertible schema empties the whole tool list (Sep 30)
Simple test schemas registered fine; Vellum's real 19–20 tools gave `init tools=0` while
the MCP server reported connected. The model, seeing tool talk in the history, wrote tool
JSON as text. Cause: `type: object` without properties (`ui_show.data`, `skill_execute.input`)
became `z.record(...)`; the SDK converts zod→JSON-schema with its own bundled zod core, and
the external zod 4.6.5 record processor throws `ctx.deferred.push` there, failing
`tools/list` for every tool. Fix: `z.looseObject` + `shapeFor()` validating each shape through
a throwaway server's `tools/list`, per-tool fallback to an open object. Debugging trap that
cost an hour: probe scripts in `/tmp` resolved zod from bun's cache and passed. Run probes
from `~/claude-shim`.

## 29. Parallel tool calls split into N round trips (Sep 30)
Batch collection waited 50 ms after the first `tool_use`, but the CLI emits one
`assistant` message per content block ~140 ms apart, so siblings were missed. Worse, the
CLI runs MCP handlers strictly sequentially: handler 2 fires only after handler 1
resolves, so even a correctly collected batch would deadlock on the second result. Fix:
close the batch on `message_stop`; key handlers by `extra._meta["claudecode/toolUseId"]`;
stash results whose handler hasn't fired in `earlyResults` and serve them when it does.
Verified: two tools → one `tool_calls` chunk → one follow-up → "served from early result".

## 30. Batch close on message_stop alone still splits 3+ tools (Sep 30, 15:40)
A live 3-tool batch through Vellum went out as 2+1: the assistant message for the third
tool_use block can arrive *after* `message_stop`. Fix: count `content_block_start` events
with `content_block.type === "tool_use"` (`expectedTus`), close the batch only when
collected ≥ expected — on `message_stop` if all blocks are in, or on the late block if not
(`late-block`); 1.5 s timer as the last resort. `[mcp] batch closed: <why> collected=N
expected=M` in the log tells which path fired. Verified: 3 tools → one `tool_calls`
response, `resolved 3`, two served from early results. Test: `scripts/test-mcp-batch3.sh`.

## 31. The batch fallback timer must be an idle watchdog, not a window from the first block (Sep 30, 15:50)
Live on Fable: `batch closed: timer collected=2 expected=3` — 1.5 s from the first tool_use block
was not enough for a model writing three calls with long `activity` strings (haiku in the spike
did it in 140 ms). The third block then arrived after the response was closed, sat in
`unobserved`, and was replayed into the *next* request as `collected=1 expected=0` (stream
events are not replayed, only assistant messages) — an extra round trip. Fix: `kickBatchTimer()`
on every stream_event resets a `BATCH_IDLE_MS` (5000, env `SHIM_BATCH_IDLE_MS`) timer; it only
fires after 5 s of silence. `message_stop` with collected ≥ expected remains the primary close.
Side finding: a `recall` in that batch hit the 120 s tool timeout because `memory-retrospective`
had TEI at 375 % CPU with a 186-deep queue — not a shim problem; batching just makes it visible.

## 32. Only the owning chat may resolve a parked handler — the compactor steals results (Sep 30, 16:00)
Vellum's in-place compaction ("Compacting in place before provider call") re-sends the WHOLE
history to the same profile WITHOUT `prompt_cache_key`, including the fresh `role: tool` result
of the handler that is currently parked. `resolveToolResults` matched it by id, un-parked the live
run into a response nobody was waiting for, and the real follow-up (compacted history, msgs 197→43,
`tail=1`) was fed to the busy CLI as a new prompt → hang, 3 daemon retries × 4 min, then
"OpenAI-compatible request failed: The operation timed out" in the chat. Fix: handler entries
carry `chatKey`; `resolveToolResults(messages, reqKey)` returns 0 when the request has no key and
skips entries whose chatKey differs (`[mcp] <id> belongs to another chat, ignoring result`).
The key-less compactor request runs as a plain oneshot, as it should.

## 33. A dropped client connection deadlocks the chat lock — abort must propagate (Oct 1, 12:15)
Vellum times a provider stream out after ~2 min of NO BYTES (not the 1800 s `streamTimeoutMs`
— that one only fires with an active connection; an idle one is cut by the client-side socket
timeout as "The operation timed out"). In MCP mode the request holds the per-chat lock while
attached to an in-flight CLI turn (model thinking / writing tool args = minutes of silence).
The shim never noticed the client was gone → chat `busy:true` forever, retries queued behind
the lock, the tool batch written to a dead stream. Fix (server.js + server-v3.js, .bak-pre-abort):
(1) SSE keepalive comment every 15 s keeps the socket alive through long thinking gaps;
(2) `req.signal` abort + ReadableStream `cancel()` release the chat lock and park the tool
batch in `cli.unobserved`; (3) `attach()` re-emits the last unanswered batch
(`cli.lastBatch`, set by `markObserved()`) to the retried request — a retried turn CAN now
re-execute a tool whose result never made it back, acceptable for idempotent Vellum tools;
(4) `[DONE]` is sent BEFORE `closed=true` (was silently dropped after it).
Lesson 24 (`effort ReferenceError`, missed replace) is exactly how the port broke the first
time: server.js had no `extra` plumbing, adding it touched fetch/run/manager signatures —
grep every call site of a signature you change, `bun build --no-bundle` catches syntax only.

## 35. Keyless requests are 400; full-history feeds warn in the chat (Oct 1, 19:55)
Anatoly's safety rule: (1) no prompt_cache_key -> immediate 400, no oneshot fallback — keyless
full-history requests (compactor, misconfigured profiles) must fail loudly, not silently burn
a fresh CLI session; (2) any turn that feeds >= SHIM_FULL_HIST_MIN (default 8) unseen blocks
emits "[shim] WARNING: full history re-feed (N/M unseen blocks, chat served K turns)" as SSE
content INTO the chat + journal. Count BLOCKS not messages: messagesToBlocks merges each
user+assistant turn into one block (12 pairs = 13 blocks), a 11-msg test at threshold 8
silently passed as 6 blocks. Legit full-history case: a chat switched onto the shim/model
mid-conversation (new chat, served=0) — expected, warning is informational there.

## 34. shim v3: VS Code extension findings ported (Oct 1, 00:00)
server-v3.js on :8320 (unit shim-v3, MCP mode, provider claude-code-v3, profiles
claude-code-v3-{opus,sonnet,haiku,fable}): verbatimPrompts (no CLAUDE.md/skill-listing
attachment, no @path/slash expansion — SDK ≥2.1.248), fallbackModel=sonnet, maxBudgetUsd
(x-shim-max-budget-usd header), settings {autoCompactEnabled, precomputeCompactionEnabled}
(compaction summary precomputed → no 4-min hang mid-turn), live effort change via
q.updateSettings({effortLevel}) (no respawn for low↔high; none/↔still respawns),
getContextUsage after each turn → usage.context_usage, rate_limit_event → usage.rate_limits +
/chats, actual_model + total_cost_usd in usage, response_format json_schema → SDK outputFormat
(one-shot only). Dropped: sdkMcpServerManifests (SDK 0.3.282 sends them itself),
excludeDynamicSections (preset prompts only), side_question (bridge-only in 0.3.282).
Also from the rate_limit_event: subscription 7-day window was at 98–99 % — watch it
before trusting Opus/Fable through any shim.

## 36. In-chat notices live at the send point, rendered red via a ```diff block (Oct 1, 23:20)
Anatoly's safety rules: (a) a request without `prompt_cache_key` gets 400 — never build a session
for a keyless full history; (b) any time ≥ `SHIM_FULL_HIST_MIN` (8) unseen blocks are fed to the
CLI, say so in the chat — the only legitimate case is a chat that just switched onto this
shim/model; (c) also announce "new chat session" and "resumed session <id>". The notices are
emitted by `shimNotice()` immediately before `cli.send()` in both `Chat._run` and `runEphemeral`,
not at the planning step, so an unforeseen re-feed path cannot bypass them. Markdown has no colour;
Vellum's web client renders a ```diff fence with a `- ` line in red, so `SHIM_NOTICE_FMT=diff` is
the default (`html`/`font`/`md` alternatives kept for other clients).
