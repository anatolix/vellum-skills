# Implementation history and decisions

Technical reconstruction of the October 1–2, 2026 implementation conversation, reconciled with the bundled code. No raw transcript, private deployment identifiers, credentials or conversation files are included.

## 1. Separate ChatGPT counterpart, not a rewrite of Claude

The initial request was to read the existing Claude Code skill and build the analogous ChatGPT subscription provider. Reuse the OpenAI-compatible Vellum boundary, not Claude-specific SDK/wrapper assumptions. Use a different skill directory, service, port, provider and session storage. Preserve the Anthropic package unchanged; a unified project is future work.

## 2. v1 proved connectivity but hit exec limitations

The first adapter used `codex exec --json`, per-turn process launches and `codex exec resume <thread>`. The native package binary bypassed a Node-dependent wrapper on a Bun-only VM. System instructions required a file via `model_instructions_file`; tools used a text `TOOL_CALL` contract. Large inline prompts caused **E2BIG**, so feed prompt text through stdin, not command-line arguments. Resume accepts fewer flags than first execution. Keep this source as an explicitly selected fallback; do not advertise v2 guarantees for it.

## 3. Switch to app-server, as used by the editor integration

Inspecting the Codex editor integration led to the persistent `codex app-server` JSON-RPC design: native dynamic tools, real SSE token/summary events, live models and loaded upstream threads. Generate protocol types from the installed CLI rather than guessing JSON shapes. `experimentalApi: true` is required for thread dynamic tools; `model/list` returns a `data` envelope.

## 4. Three tool-round hangs were adapter bugs

- Awaiting a parked dynamic request blocked the JSON-RPC reader indefinitely. Dispatch requests asynchronously.
- Saving state only after `turn/start` missed calls parked later. Persist right after parking.
- Resuming a thread already live and paused on a call blocked it. Track `liveThreads`; disk resume is for a newly started app-server only.

Server-side request IDs start at **0**; never use a truthiness check. Notifications must be routed per thread, not via one global conversation handler. Parallel fake chats and real tool-round investigation informed these fixes.

## 5. Missing chat identity caused repeated history replay and quota waste

Vellum did not pass `prompt_cache_key` for an `openai-compatible` connection. Without a stable chat key the adapter created fresh upstream threads, replayed history and failed to match parked calls. A derived first-user key initially helped but changed with fingerprints and was not a reliable production identity.

Final decision: **HTTP 400 before inference without explicit chat identity**. Add `X-Conversation-Id` to the Vellum transport where needed; `prompt_cache_key` still has priority. Keyless profile probes/background jobs must fail cheaply. Debug fallback is opt-in, not normal recovery. Re-apply shared Vellum patches after upgrades, without losing unrelated patches.

## 6. Warnings must explain lifecycle changes, not just exist in a journal

The request explicitly called for diagnostics/diffs on fresh CLI/thread work, disk resume and suspicious history feeds. New-thread logs include reason, input size, system size and tool count; invalidation shows previous state. Resume includes old/new feed and parked counts. Later feedback that a test chat looked slow and silent led to user-visible guard prefixes and per-turn timing/heartbeat logs.

The initial threshold suggestion of 6 was corrected to **more than 8 unseen blocks**. Count only blocks that will newly enter the thread; exclude assistant history and previously seen/retried blocks. Preserve that correction, not the obsolete threshold. Distinguish process startup, fresh threads and disk resume in future diagnostics.

## 7. Invisible internal tools explained otherwise mysterious work

Codex-native shell/unified-exec/sub-agent activity can happen inside app-server, beyond the caller's dynamic-tool bridge. Disable these by default so work uses Vellum's visible tools. MCP was discussed as an alternative, but the implemented Codex transport remains caller-owned **dynamic tools**. Do not claim a new MCP adapter was shipped or change Claude's existing bridge as part of this package.

## 8. Summary requests and effort must reach the actual turn

Thread-level summary configuration alone still produced empty reasoning items in observed runs. Pass `summary: "detailed"` in `turn/start`, and pass a supported effort. Vellum also stripped effort for `openai-compatible`; the second shared patch hunk preserves it. The adapter defaults to high when none is supplied. Model-side summary availability remains variable; an empty observation is not proof that summaries can never be enabled.

## 8a. Effort end to end (Oct 2)
Vellum never delivered `effort` to an openai-compatible shim even with a profile set to high: stripped in `retry.ts`, capped at xhigh in the chat-completions client, hidden in the profile editor. Fixed in Vellum (see setup §5 and `patches/`). Shim side (Anatoly's rule, Oct 2 18:00): do not guess. An explicit effort that the model does not advertise in `supportedReasoningEfforts` is rejected with 400 `unsupported_effort` before any thread/turn; a supported value, including `none`, is passed verbatim; the effective tier is logged as `[effort]`. A first version snapped to floor/ceiling; replaced the same day. Codex models advertise their own list via `model/list.supportedReasoningEfforts` (gpt-6.x: low…ultra; gpt-5.5: low…xhigh), so no hard-coded ceiling.

## 9. Honest thinking fallback uses observed token usage

The user requested some visible thinking even when the model supplies no readable summary. Preserve a real summary when present; otherwise report the **current model step's** positive integer reasoning token count. Never invent thought text from encrypted content.

Use `tokenUsage.last.reasoningOutputTokens`; do not use cumulative thread totals or count reasoning twice. Wait until the HTTP response boundary to let a late summary take precedence. Emit one fallback before finish/tool calls, reset on each response, and keep the numeric field in usage. Blank summaries and separator events do not suppress the fallback. A final reasoning item can carry text even if no deltas arrived; forward it without duplicating streamed text.

The initial 22 fake-app-server SSE regressions cover summaries/raw text/final items, encrypted-only fallback, invalid counts, usage updates, late summaries, duplicate suppression, tool pause/resume, buffering, header identity, keyless rejection and concurrent chat isolation. Packaging adds lifecycle/guard/native-tool checks and independently idempotent patch tests. No model quota is required for these regressions.

## 10. Deployment status and UI status are separate facts

A staged source update is not a restarted service. Wait for the current turn before restarting, then verify live PID/start time and matching source hash. Background restart reported the fallback active; subsequent live journal entries confirmed fallback reasoning counts. That proves transport emission, not client rendering. The Vellum UI may still need separate investigation.

## Future unified project boundaries

Preserve a provider-neutral HTTP/Vellum boundary and provider-specific adapters for auth, process/session lifecycle, tool contracts, reasoning and usage. Keep each backend's state, port and configuration isolated until an intentional migration exists. Do not flatten Claude MCP/wrapper behavior into Codex app-server behavior or change either production backend just to package shared ideas.
