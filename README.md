# vellum-skills

Skills for self-hosted [Vellum](https://github.com/vellum-ai/vellum-assistant) assistants, written to be useful to **humans and AI assistants at the same time**: each skill is a standard `SKILL.md` (machine-loadable instructions) with exact commands, verified gotchas, and expected outputs a human can follow step by step.

## Install (AI assistant)

```
assistant skills add anatolix/vellum-skills/<skill-name>
```

## Install (human)

Clone and copy the skill folder into your assistant's workspace `skills/` directory, or just read the `SKILL.md` — it is a complete runbook.

## Skills

### [tei-setup-for-vellum](tei-setup-for-vellum/SKILL.md)

Replace Vellum's two local ONNX embed-worker processes with a single shared [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) (TEI) server — **without Docker** — and switch the embedding model to **BAAI/bge-m3 (int8)**.

Why bother:

- **One model in RAM instead of two.** Vellum spawns one embed worker per owner process (daemon + memory worker) because stdin/stdout IPC is single-owner. Two 560M-param models = 3–6 GB RAM and CPU contention. TEI serves both over HTTP from one process.
- **8192-token context instead of 512.** multilingual-e5-large silently truncates Vellum's 1800-char memory segments. bge-m3 does not, and beats e5-large on Russian retrieval (MIRACL).
- **2.4 GB RSS total** after int8 quantization + `--max-batch-tokens 2048` (naive TEI startup allocates a ~10.8 GB attention arena at warmup).

Verified on Ubuntu 24.04, 4 vCPU / 16 GB, Vellum 0.12.4–0.12.5, TEI cpu-1.9.4, memory v3 live. Covers the **full lifecycle**: dockerless image extraction from ghcr, the glibc-mixing segfault, MKL/OMP thread capping, RAM capping via `--max-batch-tokens`, int8 model from a local dir — **and the post-switch re-index**: the `database is locked` fatal misclassification (patch included), the `content_hash` skip trap, why `embed_segment` jobs are no-ops under memory v3, the per-collection fill paths, and the SQL recipe to rebuild `messages_lexical` for old messages (no backfill does this).

### [claude-code-shim-provider](claude-code-shim-provider/SKILL.md)
Claude Opus/Sonnet as Vellum chat models on a Claude subscription. Claude Code CLI install, 1-year OAuth token via `setup-token`, Bun shim with **one Claude Code session per Vellum chat** (park after 1 h idle, resume on return, ~97% prompt-cache hits), OpenAI function calling via prompt contract, native system prompt, usage reporting; `vellum-mcp.ts` stdio bridge exposing Vellum tools to Claude Code (with trust-class header + tool timeout override) — used with the RichardAtCT wrapper fork. Depends on two patches from `anatolix/vellum-assistant` `local-patches`.

### [subagent-empty-response-patch](subagent-empty-response-patch/SKILL.md)
Fix for the platform bug where subagents die silently after exactly one tool call (empty post-tool LLM response, no re-query nudge for `subagentSpawn`). One-line patch to the empty-response hook, verification procedure, and links to upstream issue vellum-ai/vellum-assistant#43327 and PR #43328. Re-apply after every upgrade until the PR merges.
- **vm-env-monitoring** — VM setup and monitoring: nginx (streaming-safe proxy, /charts/), atop, 15-min health check schedule, morning Telegram load report.
