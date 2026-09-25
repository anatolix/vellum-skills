---
name: "Install and configure TEI as a custom embedding backend for Vellum"
description: "Download, install, and configure Text Embeddings Inference (TEI) v1.9.4 CPU from ghcr.io layers without Docker, set up as a systemd service on port 8081, and switch Vellum's embedding config from 'local' to the 'custom' OpenAI-compatible backend. Covers both bge-m3 and e5-large models, batch-size fix, and all gotchas."
metadata:
  vellum:
    emoji: 🚀
    activation-hints:
      - needs to replace local embed-worker.mjs processes with a single endpoint
      - user asks to set up TEI or Text Embeddings Inference on a self-hosted
        Vellum
      - embed workers are pinning CPU, user wants to consolidate embedding
      - switching embedding model or backend on self-hosted Vellum
    avoid-when:
      - the local embed workers are not causing CPU issues and the user hasn't
        asked for a change
      - user wants to change the embedding model without changing the backend
        type (use selfhost-switch-embed-model)
      - the host has no available RAM for a second heavy service (TEI loads the
        same model ~1.5 GB)
    category: system
---

# Install and configure TEI as a custom embedding backend for Vellum

## When to use

On a self-hosted Vellum instance, two local `embed-worker.mjs` processes (one for the daemon, one for the memory worker) each load the same ONNX model into RAM (~1.5 GB each) and compete for CPU cores, causing sustained high load during reindexing. TEI (Text Embeddings Inference) replaces both with a single HTTP endpoint that both daemon and memory worker call via the `custom` OpenAI-compatible backend — one model copy, one queue, dynamic batching, no CPU contention between workers.

## What you need

- A self-hosted Vellum instance with shell access
- ~3 GB free RAM for the model + MKL libraries
- ~300 MB free disk for the TEI binary and libraries
- The model runs on CPU (no GPU) — this setup uses the `cpu-1.9.4` image variant

## Model choice

Two verified models, both 1024-dim (no qdrant collection recreate needed):

| Model | Context | Pooling | Russian | Size |
|-------|---------|---------|---------|------|
| **BAAI/bge-m3** (recommended) | 8192 tokens | CLS | Excellent (SOTA multilingual) | ~2.3 GB |
| intfloat/multilingual-e5-large | 512 tokens | mean | Good | ~2.3 GB |

bge-m3 is preferred: 8192 token context means our 1800-char segments are never truncated (e5-large's 512-token limit cuts them). CLS pooling matches the old Vellum embed worker. On Russian retrieval benchmarks (MIRACL) bge-m3 outperforms e5-large.

## Procedure

### Step 1 — Download and extract TEI layers from ghcr.io

TEI ships as a Docker image on ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4. Extract its layers directly without Docker:

```bash
# Authenticate with ghcr.io
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:huggingface:text-embeddings-inference:pull" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# Get the amd64 CPU manifest
MANIFEST=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/huggingface/text-embeddings-inference/manifests/cpu-1.9.4")
AMD64_DIGEST=$(echo "$MANIFEST" | python3 -c "import json,sys; d=json.load(sys.stdin); m=[x for x in d['manifests'] if x['platform']['architecture']=='amd64'][0]; print(m['digest'].split(':')[1])")

# Get the list of layer digests
LAYERS_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/huggingface/text-embeddings-inference/manifests/sha256:$AMD64_DIGEST")
LAYER_DIGESTS=$(echo "$LAYERS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(x['digest'].split(':')[1] for x in d['layers']))")

# Download and extract each layer
mkdir -p /tmp/tei-layers /opt/tei-rootfs
for L in $LAYER_DIGESTS; do
  f=/tmp/tei-layers/$L.gz
  [ -s "$f" ] || curl -sfL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/huggingface/text-embeddings-inference/blobs/sha256:$L" -o "$f"
  sudo tar -xzf "$f" -C /opt/tei-rootfs 2>/dev/null || sudo tar -xf "$f" -C /opt/tei-rootfs
done
```

### Step 2 — Create a clean library directory with only needed MKL + iomp libs

The image ships a full Ubuntu rootfs. The binary needs only MKL .so files and Intel OpenMP. Using the image's own glibc via LD_LIBRARY_PATH conflicts with host tools (gdb, etc.), so create a clean lib dir:

```bash
sudo mkdir -p /opt/tei-libs

# MKL libraries
for so in libmkl_avx2.so.2 libmkl_avx512.so.2 libmkl_core.so.2 libmkl_def.so.2 \
          libmkl_intel_lp64.so.2 libmkl_intel_thread.so.2 \
          libmkl_vml_avx2.so.2 libmkl_vml_avx512.so.2 libmkl_vml_def.so.2; do
  sudo cp -a /opt/tei-rootfs/usr/local/lib/$so /opt/tei-libs/
done

# Intel OpenMP — this is the one that matters (libiomp5.so). It's actually libomp.so.5.
sudo cp -a /opt/tei-rootfs/usr/lib/llvm-14/lib/libomp.so.5 /opt/tei-libs/
sudo ln -sf libomp.so.5 /opt/tei-libs/libiomp5.so
```

### Step 3 — Create the systemd service unit

Critical gotchas:
- **NO LD_PRELOAD** — the image's `/usr/local/libfakeintel.so` does not exist in extracted layers and causes segfault if set
- **MKL_ENABLE_INSTRUCTIONS=AVX2** — not AVX512_E4. The host may support AVX512f but TEI's MKL build crashes with it on this stack
- **RAYON_NUM_THREADS=4** — match host nproc
- **--max-client-batch-size 64** — Vellum's concept-page reembed sends batches of 50, but TEI defaults to 32. Without this flag, reembed fails with "batch size 50 > maximum allowed batch size 32"

```bash
sudo mkdir -p /var/lib/tei/data

# For bge-m3 (recommended):
MODEL_ID="BAAI/bge-m3"

# For multilingual-e5-large (fallback):
# MODEL_ID="intfloat/multilingual-e5-large"

cat > /tmp/tei.service <<UNIT
[Unit]
Description=Text Embeddings Inference ($MODEL_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vellum
ExecStart=/opt/tei-rootfs/usr/local/bin/text-embeddings-router \
  --model-id $MODEL_ID \
  --port 8081 --hostname 127.0.0.1 --json-output \
  --max-client-batch-size 64
Environment=HUGGINGFACE_HUB_CACHE=/var/lib/tei/data
Environment=LD_LIBRARY_PATH=/opt/tei-libs
Environment=MKL_ENABLE_INSTRUCTIONS=AVX2
Environment=RAYON_NUM_THREADS=4
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
UNIT

sudo cp /tmp/tei.service /etc/systemd/system/tei.service
sudo systemctl daemon-reload
sudo systemctl enable --now tei.service
```

### Step 4 — Wait for model load and verify health

The model (~2.3 GB) downloads on first start. Wait 2-5 minutes depending on network:

```bash
# Watch startup progress
sudo journalctl -u tei.service --no-pager -n 20 -f

# Once it says "Ready", verify health
curl -s http://127.0.0.1:8081/health
# Should return "OK"

# Check model info
curl -s http://127.0.0.1:8081/info | python3 -m json.tool
```

Expected /info output:
- model_id: BAAI/bge-m3 (or intfloat/multilingual-e5-large)
- pooling: cls (bge-m3) or mean (e5-large)
- max_batch_requests: 8
- max_client_batch_size: 64
- auto_truncate: true
- dimensions: 1024
- max_input_length: 8192 (bge-m3) or 512 (e5-large)

### Step 5 — Test an embedding request (OpenAI-compatible format)

```bash
curl -s -X POST http://127.0.0.1:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":["привет мир","hello world"],"model":"BAAI/bge-m3"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('vectors:', len(d['data']), 'dim:', len(d['data'][0]['embedding']), 'model:', d.get('model'))"
```

Expected: `vectors: 2 dim: 1024 model: BAAI/bge-m3`

### Step 6 — Switch Vellum config to custom backend

```bash
assistant config set memory.embeddings.provider custom
assistant config set memory.embeddings.baseUrl http://127.0.0.1:8081/v1
assistant config set memory.embeddings.customModel BAAI/bge-m3
assistant config set memory.embeddings.customDimensions 1024
```

### Step 7 — Restart the daemon

```bash
sudo -u vellum env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart vellum-juno.service
```

After restart, verify both daemon and memory worker are using TEI:

```bash
# No more embed-worker.mjs processes
ps -eo pid,ni,pcpu,etime,args | grep "embed-worke[r]" || echo "NO LOCAL EMBED WORKERS — TEI working"

# Verify TEI is being called (watch logs)
sudo journalctl -u tei.service --no-pager -n 5
```

### Step 8 — Trigger reembed for existing vectors

Switching backends does NOT automatically re-embed existing data. Existing vectors in qdrant were produced by the old backend and are semantically different from new TEI outputs. Force a full reembed:

```bash
# Enqueue a forced backfill (re-indexes all messages)
DB=~/.vellum/workspace/data/db/assistant-memory.db
NOW=$(date +%s%3N)
sqlite3 "$DB" "insert into memory_jobs (id,type,payload,status,attempts,deferrals,run_after,created_at,updated_at) values ('tei-switch-backfill-$(date +%s)','backfill','{\"force\":true}','pending',0,0,$NOW,$NOW,$NOW);"

# Also reembed concept pages
assistant memory v2 reembed
```

The backfill runs in background via the memory worker. Watch TEI logs for progress.

### Step 9 — Verify memory search still works

```bash
assistant memory v3 status
# Check qdrant collections have points
curl -s http://127.0.0.1:6333/collections | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['collections']; [print(c['name'],'- points from /info') for c in d]"
```

## Companion files

- `references/failure-modes.md` — segfault signatures, missing lib errors, and recovery.

## Testing checklist

- [ ] `/info` shows model loaded with correct pooling, 1024 dim, max_client_batch_size=64
- [ ] `/v1/embeddings` returns correct vectors
- [ ] No `embed-worker.mjs` processes in `ps`
- [ ] `assistant memory v3 status` reports healthy
- [ ] `sudo journalctl -u tei.service` shows no segfaults or crashes
- [ ] Daemon restart doesn't spawn local embed workers
- [ ] TEI survives `sudo systemctl restart tei.service` with auto-reload
- [ ] Backfill runs without "batch size 50 > 32" errors

## Gotchas

- **libiomp5.so resolution**: The binary links against `libiomp5.so` (Intel OpenMP). The image ships it as `libomp.so.5` under `/usr/lib/llvm-14/lib/`. Create a proper symlink in the clean lib dir. Without it, the binary exits with `error while loading shared libraries: libiomp5.so: cannot open shared object file`.
- **AVX512 segfault**: On this host (Skylake-class with AVX512f), `MKL_ENABLE_INSTRUCTIONS=AVX512_E4` causes immediate SIGSEGV. Use `AVX2` instead. The MKL dispatch layer detects the actual instruction set at runtime anyway.
- **LD_PRELOAD libfakeintel.so**: The Docker image uses this to fake Intel CPU detection. The file doesn't exist in the extracted layers. Setting it causes a harmless warning at startup and a SIGSEGV on model load. Drop it entirely.
- **max-client-batch-size**: Vellum's concept-page reembed sends batches of 50. TEI defaults to 32. Without `--max-client-batch-size 64`, the first reembed request fails with "batch size 50 > maximum allowed batch size 32".
- **First model download**: ~2.3 GB from HuggingFace Hub. Takes 2-5 minutes. During this time, TEI returns 503 for health checks. Vellum embedding requests will fail until the model is loaded.
- **Clean lib dir**: Don't use the image's full `/usr/lib/x86_64-linux-gnu` in `LD_LIBRARY_PATH` — its glibc version conflicts with the host's. The host's native glibc handles the binary fine when only MKL + iomp5 paths are in `LD_LIBRARY_PATH`.
- **bge-m3 vs e5-large pooling**: bge-m3 uses CLS pooling, e5-large uses mean pooling. Both produce 1024-dim vectors, so qdrant collections don't need recreating. But vectors from different backends ARE semantically incompatible — always force a full reembed after switching.

## Reference Files

The following reference files are available in this skill's directory. Use `file_read` to load any that are relevant to the current task:

- `references/failure-modes.md` (references/failure-modes.md)

Included Skills (immediate): none
