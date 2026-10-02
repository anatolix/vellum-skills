---
name: codex-shim-provider
description: Install, configure, diagnose, and update a self-hosted Vellum chat provider backed by the Codex CLI and a ChatGPT subscription, with persistent per-chat threads, dynamic tools, SSE thinking and usage. Covers this OpenAI shim, not the separate Anthropic/Claude shim.
---

# Codex / ChatGPT as a Vellum chat provider

A separate sibling of `claude-code-shim-provider`. Use `scripts/server-v2.js`: one long-lived `codex app-server`, one persisted upstream thread per Vellum conversation, and OpenAI-compatible HTTP on **127.0.0.1:8321**. The bundled v1 `server.js` is a legacy fallback with different guarantees, not the normal deployment.

## Preserve the other provider

- Keep the `codex-chatgpt` connection, `codex-*` profiles, `codex-shim.service`, `~/codex-shim/` and port 8321 separate from Claude's equivalents. Inspect existing listeners/config before installation; do not overwrite a sibling provider or share its state directory.
- Do not alter or restart the Claude service, its code, MCP bridge or configuration. Packaging/updating this skill does not itself authorize deployment or merging the implementations.
- The optional Vellum patch edits a **shared** `retry.ts`. Review its diff and preserve other patches. It adds conversation headers and effort support for `openai-compatible`; it does not change the `anthropic` branch. Full effort pass-through also needs `patches/vellum-0.12.6-openai-compatible-effort.patch` (retry.ts set, adapter-factory ceiling, web profile editor) — see setup §5. Back up before changes and re-check sibling providers when applying it.
- Never publish ChatGPT auth files, session/rollout data, raw conversation exports, credentials or private runtime configuration. The history reference contains technical decisions only.

## Install and authenticate

Read [references/setup.md](references/setup.md) for the verified Linux x86-64, Bun-only installation, headless device auth, deployment, provider registration and quota-free smoke checks. Baseline: Codex **0.159.3**, Bun, Python 3 and user systemd; re-verify the app-server protocol when upgrading.

```bash
assistant skills add anatolix/vellum-skills/codex-shim-provider
```

Run setup commands from this skill's directory. Use live `/v1/models`, not a hard-coded model catalog. Login runs through `codex login --device-auth`; the user authenticates with OpenAI, not by sharing auth files in chat.

## Non-negotiable runtime invariants

- Reject missing `prompt_cache_key` / `X-Conversation-Id` with HTTP **400** before inference. No silent derived session key in normal operation. `SHIM_ALLOW_KEYLESS=1` exists for manual debugging only.
- Feed only unseen user/tool blocks; assistant history is not re-fed. Log and stream a replay warning only for **more than 8 unseen blocks** by default (`SHIM_MAX_FEED`). Previously seen history and retry replay do not count.
- Show new-thread, invalidation and disk-resume notices in the chat as well as the journal. A thread is not a newly spawned CLI: one app-server process can own many threads.
- Keep the JSON-RPC reader nonblocking. Park dynamic calls, save their RPC IDs immediately, install the next HTTP handler before answering them, and do not resume a thread already live in app-server. RPC ID **0 is valid**.
- Keep invisible Codex-native shell/unified-exec/multi-agent features off by default. Tools supplied by Vellum remain dynamic caller-owned tools. This package does **not** include a Codex MCP adapter; Claude's bridge is untouched.
- Request `summary: "detailed"` and the caller's effort on **each turn**; an effort the model does not advertise is a 400 `unsupported_effort` before inference (no guessing, no snapping). Forward real readable reasoning; otherwise emit the positive, valid `tokenUsage.last.reasoningOutputTokens` count as `reasoning_content` at the HTTP response boundary. Do not decode encrypted content, use lifetime totals, fabricate reasoning, duplicate a summary, or claim the counter is live.

Read [references/architecture.md](references/architecture.md) when changing code, session handling, tools, guards, retries, thinking or usage. Read [references/lessons-learned.md](references/lessons-learned.md) for the implementation history and boundaries to retain in a future unified project.

## Verify without spending model quota

```bash
python3 tests/test-reasoning.py
python3 tests/test-patch.py
bash -n scripts/run.sh scripts/patch-vellum-retry.sh
```

Tests use a fake app-server on an ephemeral port and temporary state. They do not touch the deployed service or use a real model. Read [references/failure-modes.md](references/failure-modes.md) before escalating a hang, missing thinking, cache miss or restart problem. Inspect logs/exports before blaming the UI: emitted/persisted reasoning is not proof that a client rendered it.
