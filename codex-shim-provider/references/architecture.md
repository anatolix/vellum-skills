# Runtime architecture and contracts

## Processes and state

`server-v2.js` is a Bun HTTP server. It launches one `codex app-server` subprocess and speaks newline-delimited JSON-RPC over stdin/stdout. A CLI launch is different from a new upstream thread; many conversations share the process, not their threads.

The model list comes from `model/list` (`data`, filtered for non-hidden models). Initialize with `capabilities.experimentalApi: true` for dynamic tools. Generate current protocol types locally with `codex app-server generate-ts --experimental --out <temporary-directory>` when upgrading.

Session key precedence: body `prompt_cache_key`, then `X-Conversation-Id`. Missing key is a pre-inference HTTP 400 `missing_session_key`. Debug-only `SHIM_ALLOW_KEYLESS=1` derives an identity from the first user block and fingerprint; it is unsafe as a production fallback.

Session state files are `SHIM_SESSIONS_DIR/<sha1(key)>.json`, storing thread ID, model, fingerprint, fed block hashes and parked calls. Rollouts belong to Codex under `~/.codex/`. Neither is part of the source package. Keep separate state dirs/ports/units from Anthropic. The app-server uses the login user's `~/.codex` home by default (`SHIM_CODEX_HOME` overrides it for isolated tests); it is not a multi-user auth router.

Fingerprint = system/developer prompt plus **stable tool names**. Client-dependent tools (`request_system_permission`, `ask_question`, `host_*`; override with `SHIM_VOLATILE_TOOLS`) are excluded: Vellum adds/removes them per connected device, and a phone<->laptop switch must not replace the thread. They are still offered to the thread as the union of the current request and every volatile tool seen before (`SHIM_SESSIONS_DIR/volatile-tools.json`); a call to one the current request lacks is answered with an error (`success: false`) instead of being parked. Pre-Oct-4 session fingerprints migrate once (`[fp] migrated`). A model or fingerprint change creates a new thread and emits an invalidation notice/diff. Tool schemas/descriptions are not currently fingerprinted; do not silently change these mid-thread expecting them to update upstream.

For **warm/resumed threads**, only nonempty user blocks and tool results are candidates for incremental feeding; assistant history is skipped because the CLI already owns its replies. For a **fresh thread** (first request, model/fingerprint change, retry after failed resume), `history-rehydration.js` serializes ALL non-system incoming messages in chronological order: assistant-role `<context_summary>`, kept user/assistant turns, and recorded tool calls/results. Historical tool calls/results are text, never live RPCs. This uses the Vellum request context (summary + preserved tail), not the uncut UI/database archive. System/developer instructions still go via baseInstructions. A warm thread never replays this historical packet. Unseen blocks positioned **before the last seen block** are rewritten history (reload after idle, compaction, `/clean`, memory re-injection), not new input: they are marked seen but never fed (`[guard] HISTORY-EDIT`, red notice «Не отправлено»). Only the tail after the last seen block is fed; a tool result for a still-parked call is always delivered. A new thread (model or fingerprint change) has no seen marks and receives the full history. Hashes identify previously seen content. Repeated identical user content is therefore treated as seen and may enter retry-tail replay; this is content-based deduplication, not message-ID tracking.

## Dynamic tool transport

1. `thread/start` supplies the caller's OpenAI function definitions as dynamic tools plus the caller's system prompt as `baseInstructions`.
2. `item/tool/call` is a **server-to-client request**. Save its JSON-RPC ID (including 0) under a new OpenAI `call_*` ID immediately, emit OpenAI tool calls, and end this HTTP response. Leave the upstream turn parked.
3. The next request's matching tool result becomes a JSON-RPC response with `contentItems: [{type: "inputText", text: ...}]` and `success: true`. Register the new notification handler **before** sending it.
4. Do not await a parked request in the reader; its promise deliberately never resolves there. Async dispatch keeps the reader moving.
5. `liveThreads` tracks threads already loaded in this app-server. Never `thread/resume` a live parked thread. On process restart, resume disk state, clear stale parked RPC IDs, and recover/retry if necessary.

Native shell/unified-exec/multi-agent features are disabled in `thread/start.config.features`. `SHIM_NATIVE_TOOLS=1` is an explicit override; internal tools then bypass Vellum visibility/approval handling. The package ships **dynamic tools, not a new MCP server**. Keep Claude's existing MCP and wrapper approach independent until an explicit future merge.

Caller-side approval behavior remains with Vellum's tools. Codex uses `approvalPolicy: "never"` and a configured sandbox; legacy server-initiated approval requests are auto-accepted by the adapter. Do not enable native tools for tasks that need user-mediated approvals without reviewing that behavior. Same-chat concurrent HTTP requests are not serialized; serialize tool rounds for each key.

## Guards and visibility

- **NEW THREAD**: reason, model, system size, tool count and fed blocks/chars. On invalidation, `[guard] DIFF prev:` includes old thread/model/fingerprint/fed count.
- **RESUME**: a thread restored from disk, old fed count, new user/tool counts and parked count. No resume notice on a normal live-thread continuation.
- **REPLAY-SUSPECT**: more than `SHIM_MAX_FEED` (**8** default) unseen user/tool blocks in one request. Exactly 8 is allowed; previously fed history and retry-tail replay do not trigger the threshold. It is a diagnostic warning, not a rejection.
- Notices (Oct 3+) are short red lines delivered as a fake failed `__shim_notice__` tool call. See `shim-notices.md`. The old italic `_⚙ шим: …_` content lines are gone. Journal `[guard]` lines keep the full details. A new CLI launch/restart is separately logged as `[appserver] starting`.
- `[turn]` telemetry records first text/reasoning, summary boundaries, a 15-second heartbeat for silent turns, completion/error/timeout and usage fallback. No fake thinking is generated by the heartbeat.

Since Oct 3 the large-context notice fires on both new and existing threads.

## Retries and restart boundaries

When all incoming blocks are already seen, retry the trailing unanswered user/tool content instead of an immediate 400. A still-live parked call receives its result; if its process/RPC ID is gone, recover tool results as text where supported. A failed disk resume removes local mapping and asks the caller to retry. Do not reset all sessions or replay all history as the first troubleshooting step.

Wait for a turn to finish before a service restart. Updating a file alone does not update the running process; verify PID/start time plus the deployed source hash after a planned restart. A profile/model switch can intentionally invalidate a thread and must be visible.

## Thinking and usage

`turn/start` requests `summary: "detailed"` plus the effort. Body `reasoning_effort`, then `reasoning.effort`, then `SHIM_DEFAULT_EFFORT` (**high**). An explicit value is **validated, never snapped**: it must be in the model's `supportedReasoningEfforts` from `model/list` (fallback: the known tier names when the model advertises none); anything else, including a non-string or `none` on a model that does not list it, is HTTP **400 `unsupported_effort`** before any thread or turn is created. The effective tier is recorded in `[effort]` journal entries.

Mapping:

| Upstream event | OpenAI-compatible output |
| --- | --- |
| `item/agentMessage/delta` | `delta.content` (buffered when caller tools exist) |
| `item/reasoning/summaryTextDelta` | `delta.reasoning_content` |
| `item/reasoning/textDelta` | exposed readable `reasoning_content` only |
| final `item/completed` reasoning item | summary/content text if that item was not already streamed |
| `thread/tokenUsage/updated.tokenUsage.last` | usage, including cached input and reasoning output tokens |
| no readable reasoning, valid positive reasoning count | one fallback thinking entry at response boundary |

Fallback text: `[codex-shim] Reasoning: N токенов. Summary недоступна.` It appears before finish/tool calls, including a tool pause or failed turn. Wait until that boundary so late real summaries win. Whitespace/separators do not count as readable reasoning. Deduplicate by reasoning item and reset per HTTP response.

Usage `last.reasoningOutputTokens`, not thread `total`, is also emitted as `usage.completion_tokens_details.reasoning_tokens`. Reasoning tokens are already included in output tokens; do not add them again to totals. Reject missing, zero-as-thinking, negative, fractional, string or unsafe-integer counts. A reported zero remains valid usage metadata but produces no artificial thinking.

Counts arrive **after a model step**, not continuously during silent generation. Encrypted content is opaque and is never decoded or presented as a summary. Real summary availability depends on the model/account/turn; historic observations do not prove a permanent model-level ban. Successful SSE/persistence does not guarantee the Vellum web UI rendered thinking.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `SHIM_PORT` | 8321, loopback only |
| `CODEX_BIN` | `~/.local/bin/codex` |
| `SHIM_CODEX_HOME` | optional isolated app-server home; default `~/.codex` |
| `CODEX_WORKDIR` | `~/codex-shim/workdir` |
| `SHIM_SESSIONS_DIR` | `~/codex-shim/sessions` |
| `SHIM_MODELS` | optional comma-separated model override; otherwise live list |
| `SHIM_SANDBOX` | `workspace-write`; alternatives `read-only`, `danger-full-access` |
| `SHIM_DEFAULT_EFFORT` | `high` |
| `SHIM_REASONING_SUMMARY` | `detailed` |
| `SHIM_MAX_FEED` | 8 unseen blocks; warns on strictly more |
| `SHIM_DEBUG` | verbose event logs when nonempty |
| `SHIM_ALLOW_KEYLESS` | absent in production; debug-derived identity when nonempty |
| `SHIM_NATIVE_TOOLS` | absent by default; native tools when nonempty |
| `SHIM_SERVER` | launch script chooses `server-v2.js`; optional legacy `server.js` |

These flags use nonempty/truthy values; `SHIM_NATIVE_TOOLS=0` / `SHIM_ALLOW_KEYLESS=0` still enable their respective overrides. Unset them to disable. Do not expose the listener publicly without separate authentication: the shim itself has no bearer-auth layer, and `/chats` contains session metadata.

## History-edit forensics (Oct 4)

Every rewritten-history event (`HISTORY-EDIT`, notice «Не отправлено») is dumped to `~/codex-shim/history-edits/` (override `SHIM_HISTEDIT_DIR`): one `<timestamp>-<key>.json` per event with the full new text of every skipped block, its position, and what the thread previously had at that index (hash, length, first 300 / last 200 chars — kept per fed block in the session state as `meta`), plus an `index.jsonl` summary line (`kinds` = `user#12(4100->4350),…`). `aligned:false` means the block count changed, so the positional "previous" is only a hint.

## Compaction (Oct 4)

Vellum's compaction call (trailing `<compaction_instructions>` user message, `tool_choice: none`, expects `<compaction_result>`) is never fed to the live thread. It is recognised by the `X-Call-Site: compactionAgent` header (local Vellum patch `scripts/patch-vellum-compaction.sh`: `compactor.ts` passes `selectionSeed`/`conversationId` so `prompt_cache_key` names the chat; `retry.ts` adds `X-Call-Site`/`X-Conversation-Id` for openai-compatible providers) or, without the patch, by `tool_choice=none` plus the instruction block.

codex-shim: `thread/fork` the live thread → run the instruction in the fork (tool calls refused with an error) → stream the model's `<compaction_result>` to Vellum → `thread/delete` the fork → `thread/compact/start` on the live thread and wait for the `contextCompaction` item. A `<tail_start>` that does not resolve to any Vellum user block (the model likes codex's own `<environment_context>`) is replaced by the second-to-last user turn's `<turn_context>` timestamp + preview, otherwise Vellum aborts with `tail_start unresolved`. Nothing is marked seen; the next request shows one red «Компакция: …» notice instead of «Не отправлено». 409 `no_thread` when the chat has no thread yet, 409 `busy` while a tool call is parked. Measured: ~30 s per compaction (fork summary ~18 s, native ~10 s); the first turn after compaction rebuilds the prefix cache (~50 % cached), from the second turn on ~98 % cached.

claude-shim: the live CLI (started with `verbatimPrompts`, which disables slash commands) is closed; a one-off process resumes the same session with `verbatimPrompts: false`, sends `/compact` and captures the CLI's own summary via the `PostCompact` hook (`compact_summary`). The shim wraps it as `<compaction_result>` with `tail_start` = second-to-last user turn (timestamp from `<turn_context>`, preview = text after injected tags). The next request resumes the compacted session from disk («Старт: из файла»), then «Компакция: pre→post токенов». Measured: ~22 s; CLI context 7.2K→1.3K tokens in the test; cache fully warm from the second turn after compaction.

Both shims also re-identify rewritten blocks by tail match (last 200 chars, blocks ≥ 300 chars) so Vellum's post-compaction injection strip on the kept tail is not mistaken for new input.

### Compaction: result-tag literals in the summary

Vellum parses `<compaction_result>` with plain `indexOf`/regex scans. If the summary text itself
*mentions* `<summary>`, `<tail_start …>` etc. (any chat about the shims does), the literal wins the
regex → empty attrs → "Context compaction skipped — unparseable response". Both shims now neuter such
literals inside the summary/key_state bodies (`<` → `‹`, `neuterResultTags`); codex-shim re-parses the
model-written block structurally first (`sanitizeCompactionResult`: real `<tail_start` is the last one,
real `</summary>` is the last one before `<key_state>`). The final block sent to Vellum is dumped to
`~/{codex,claude}-shim/compact-dumps/<iso>-<tag>.txt` for forensics.

**Compaction after a shim restart (claude-shim):** chats load lazily on their first normal turn, so a
compaction arriving first used to hit `manager.chats.get()` → 409 `no_session` → Vellum "provider error"
(seen 2026-10-04 08:49, three retries). `handleCompaction` now loads the saved state from disk like
`manager.get()` does. codex-shim was never affected (`loadState()` reads disk).

### Compaction detection and the tail marker (2026-10-04, prod findings)

- `X-Call-Site` **never reaches the shims**: `retry.ts` (local patch) puts it into `config.requestHeaders`,
  but Vellum's openai-compatible provider does not read `requestHeaders` at all (only Fireworks does).
  `tool_choice` is also omitted for some models (gpt-6.1-sol sends none, claude-fable sends `"none"`).
  Both shims therefore detect a compaction call by the trailing user message *opening* with
  `<compaction_instructions>` / `<emergency_compaction>`. Undetected compaction = a normal turn: codex
  rebuilt the thread (bigger system prompt → new fingerprint) and answered the instruction inside the
  live thread; Vellum even accepted that summary once (09:00 UTC) — but no native compact happened.
- `<tail_start>` is resolved by Vellum by exact `turn_context` timestamp (user messages) or by preview
  (first message whose head matches — ambiguous). Slash commands (`/compact`) and `<system_notice>`
  wrappers have no turn_context and an empty stripped preview, so picking "second-to-last user message"
  blindly produced `timestamp="" preview=""` → "unparseable response". Both shims now pick the
  second-to-last user message **that carries a `<turn_context>`** (`turnContextTime()`).
- `[req]` lines now log `tc=<tool_choice> site=<x-call-site>` so this can be checked in production.
- Request bodies Vellum sent are stored in `workspace/data/db/assistant-logs.db`, table
  `llm_request_logs` (`call_site='compactionAgent'`) — use that instead of guessing.


### Explicit compaction intent (2026-10-04)

Vellum resolves compaction through `mainAgent` to preserve the active profile/cache;
`compactionAgent` is only the request-log label. Generic reasoning adapters can omit
`tool_choice=none`. Neither is a reliable operation marker. The runtime patch now adds
`X-Shim-Operation: compact` to both normal and emergency compactor requests without
changing routing. Both handlers and NoticeTransport use one `isCompactionRequest`
predicate before any pending-notice continuation. Older daemons are recognized only
when the latest user's text STARTS with the compaction instruction tag (not quoted
tags in prior history or ordinary prose). No diagnostics are parked in the summary path.

The previous failure returned only a synthetic diagnostic tool to the compactor, then
resumed its old summary stream on the next normal Test message. This caused both an
unparseable summary and raw XML in ordinary chat.

Regression: `bun test scripts/compaction-routing.test.js` (14 tests). Isolated live Codex
test with `mainAgent`, high reasoning, tools present, explicit operation and NO tool_choice:
valid summary, native thread compaction, secret code and document count retained, next
ordinary turns answered correctly with ~98% cache. Claude live smoke was blocked by
subscription quota; no end-to-end success is claimed for that run.


## Permission description versus enforcement

`include_permissions_instructions = false` suppresses Codex's `<permissions instructions>` developer text without altering the sandbox policy. The shim sets it on both `thread/start` and `thread/resume`; the local Codex config also sets it at the top level. Invisible native tools remain disabled. Already-recorded instructions in old thread history are not erased; a fresh thread is needed to guarantee a clean history. Real isolated Codex 0.159.3 smoke: effective flag false, readOnly/networkAccess false returned by thread/start, answer OK, zero permission developer blocks in rollout.

## Summary rehydration regression (Oct 4, 2026)

Vellum intentionally retains the full UI/database archive. Compaction persists context_summary separately and sends it as an assistant message ahead of the kept tail. Dropping all assistant messages was correct only for an existing CLI, not a new one. Test facts must occur ONLY in an old assistant reply or its summary, never in kept user messages: native compact -> switch model -> switch back -> ask for those exact facts. A separate CODEX_HOME is essential because app-server daemons can otherwise share state. Also ensure detached compact completion cannot update a replacement thread's state.

Offline: `bun test codex-shim-provider/scripts/{history-rehydration,compaction-routing}.test.js`. Real Oct-4 smoke on :8346/:8347 passed for both engines, including forced fresh Claude sessions; see workspace scratch/context-loss-20261004/live for sanitized response/usage records.
