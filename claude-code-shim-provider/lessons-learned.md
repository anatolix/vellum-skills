
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
