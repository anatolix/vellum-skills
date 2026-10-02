# shim-router — cascade provider for Vellum internal call sites

Route Vellum's background/internal LLM call sites through paid-free subscriptions first, with paid OpenRouter as the last resort. Born Oct 3 2026 after internal subsystems (memory consolidation, subagent spawn, vision captions, greetings) burned ~$8/day on `balanced` = paid `anthropic/claude-sonnet-4.6`.

## Cascade

1. **claude-shim :8320** → `claude-sonnet` (Claude subscription via Claude Code CLI — see `claude-code-shim-provider`)
2. **codex-shim :8321** → `gpt-6-luna` (ChatGPT subscription via Codex CLI — see `codex-shim-provider`)
3. **OpenRouter** → `anthropic/claude-sonnet-4.6` (paid fallback)

## Design rules (hard-won)

- **Cascade down ONLY on:** network error, first-byte timeout (240s default), HTTP 429, HTTP 5xx. A 4xx (except 429) means the REQUEST is broken — pass it through untouched, never retry it against the next upstream.
- **Mid-stream failures are never retried.** Once the first SSE chunk is delivered to the client, the stream just ends on upstream failure; retrying would duplicate partial output.
- **prompt_cache_key / one-use semantics:** both shims reject keyless requests with 400, and Vellum only stamps `prompt_cache_key` for conversation-scoped calls — internal call sites arrive without one. The router injects a STABLE `prompt_cache_key: router-oneuse-<sha1(first system|user blocks)[:24]>`. Stable (not per-request uuid) so a task's tool round-trips reach the same in-flight process.
- **One-use contract in both shims** (`router-oneuse-*` keys): the CLI/thread is killed right after its turn completes, never parked/persisted to the sessions dir, never counted against the live-chat pool (`SHIM_MAX_LIVE`), and listed separately from real chats in `/chats`. claude-shim: tool-less requests go through `runEphemeral` (tag `oneuse`); tool-bearing ones get a transient Chat capped by `SHIM_MAX_ONEUSE` (16), destroyed by `maybeDestroyOneUse` once no tool handlers are parked (15 min idle reaper, `SHIM_ONEUSE_IDLE_MS`). codex-shim: state lives only in memory (`oneUseStates`), thread dropped + forgotten when the turn ends with no parked calls; `/chats` reads the sessions dir, so one-use threads never appear in monitoring.
- **Why not Vellum's `fallbackProfile`:** the fallback-route resolver only fires for managed default profiles (`source: "managed"` + `isDefaultProfileKey`); custom profiles cannot get a backup. An upstream-side cascade inside a tiny proxy is the supported-shaped workaround. (Patching shim-v3 itself was explicitly rejected by the user — keep shims single-purpose.)

## Files

- `scripts/server.js` — Bun server, `127.0.0.1:8322`. Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`.
- `scripts/shim-router.service` — systemd user unit (Restart=always). Env via `EnvironmentFile=/home/vellum/shim-router/env` (chmod 600) holding `OPENROUTER_API_KEY`.

## Install

```bash
mkdir -p /home/vellum/shim-router
cp scripts/server.js /home/vellum/shim-router/server.js
printf 'OPENROUTER_API_KEY=%s\n' "$(assistant credentials reveal --service openrouter --field api_key)" > /home/vellum/shim-router/env
chmod 600 /home/vellum/shim-router/env
cp scripts/shim-router.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shim-router
curl -s http://127.0.0.1:8322/health
```

## Vellum wiring

```bash
assistant inference providers create shim-router --provider openai-compatible \
  --base-url http://127.0.0.1:8322/v1 --model router-auto
assistant inference profiles create shim-router --provider openai-compatible \
  --model router-auto --connection shim-router --effort high --max-tokens 16000 \
  --thinking on --allow-unlisted
assistant inference send --profile shim-router "Reply with exactly: OK"
```

Then pin internal call sites in `config.json` → `llm.callSites` (the daemon's config watcher picks edits up live, no restart):

```json
"callSites": {
  "subagentSpawn": {"profile": "shim-router"},
  "memoryV2Consolidation": {"profile": "shim-router"},
  "...": "…36 internal sites…"
}
```

Pinned in production (36 sites): all memory* sites, compactionAgent, subagentSpawn, workflowLeaf, conversationStarters/Summarization/Title, emptyStateGreeting, identityIntro, homeGreeting, homeSuggestedPrompts, approval/guardian copy, styleAnalyzer, preferenceExtraction, notificationDecision, inference, replySuggestion, commitMessage, recall, patternScan, narrativeRefinement, trustRuleSuggestion, skillCategoryInference, inviteInstructionGenerator.

**Deliberately NOT routed** (keep their own profiles):
- `mainAgent` — user chats have explicit profiles.
- `callAgent`, `voice*`, `interactionClassifier` — realtime latency-sensitive; they stay on `latency-optimized` (haiku).
- `vision`, `autoProfileRouter`, `voiceEscalationJudge` — "(anchor)" sites that follow the conversation's profile.

## Timeouts

- Router: connect+first-byte 240s (`SHIM_ROUTER_FIRST_BYTE_TIMEOUT_MS`), no cap after streaming starts.
- Vellum stream timeout default is 30 min (`adapter-factory.ts` `streamTimeoutMs ?? 1_800_000`) — no override needed.

## Diagnostics

- `journalctl --user -u shim-router` — `[ok] <upstream> (<ms>)` / `[fail] <upstream>: <why>` per attempt.
- `curl 127.0.0.1:8322/health` → upstream list.
- Spend attribution: `llm_usage_events` in `data/db/assistant.db` (columns: model, inference_profile, call_site, estimated_cost_usd — estimates run high vs real billing; ground truth is `GET https://openrouter.ai/api/v1/auth/key` `usage_daily`).

## Verified live (Oct 3 2026)

All three rungs exercised by stopping units in sequence: claude-shim OK → shim-v3 stopped → codex gpt-6-luna OK → codex stopped → OpenRouter sonnet OK (~1.2s). End-to-end `assistant inference send --profile shim-router` → OK.
