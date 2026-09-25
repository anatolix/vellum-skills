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

Verified on Ubuntu 24.04, 4 vCPU / 16 GB, Vellum 0.12.4–0.12.5, TEI cpu-1.9.4. Covers: dockerless image extraction from ghcr, the glibc-mixing segfault, MKL instruction flags, qdrant collection wipe, and a full re-embed from scratch.

## License

MIT. Use, adapt, republish.
