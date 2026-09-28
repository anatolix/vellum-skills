
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
