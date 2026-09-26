---
name: "TEI embedding backend for Vellum — install, switch, re-embed, recover"
description: "Full lifecycle of moving a self-hosted Vellum instance from local embed-worker.mjs processes to Text Embeddings Inference (TEI): dockerless install from ghcr.io layers, systemd unit, model choice (bge-m3 int8), config switch, full re-index under memory v3, and recovery of every failure mode we hit (SQLite-lock fatal misclassification, content_hash skip trap, v1 no-op jobs, empty lexical index). Verified on Ubuntu 24.04, Vellum 0.12.x, TEI cpu-1.9.4."
metadata:
  vellum:
    emoji: 🚀
    activation-hints:
      - needs to replace local embed-worker.mjs processes with a single endpoint
      - user asks to set up TEI or Text Embeddings Inference on a self-hosted Vellum
      - embed workers are pinning CPU, user wants to consolidate embedding
      - switching embedding model or backend on self-hosted Vellum
      - memory collections are empty/partial after a model change
      - memory_jobs shows failed backfills, semantic search lost old content
    avoid-when:
      - the local embed workers are not causing CPU issues and the user hasn't asked for a change
      - user wants to change the embedding model without changing the backend type
      - the host has no available RAM for a second heavy service (TEI loads the model ~2.4 GB)
    category: system
---

# TEI embedding backend for Vellum — install, switch, re-embed, recover

This is the complete runbook for one job: getting a self-hosted Vellum instance off its local ONNX embed workers and onto a single TEI server, **including the re-index and everything that goes wrong after the config switch**. Verified Sep 25–26, 2026 on Vellum 0.12.4 self-hosted, memory **v3 live**, Ubuntu 24.04 4 vCPU/16 GB.

## Why

Two local `embed-worker.mjs` processes (daemon + memory worker) each load the same model into RAM (~1.5 GB each) and fight for CPU. TEI replaces both with one HTTP endpoint — one model copy, one queue, dynamic batching.

## What you need

- Self-hosted Vellum instance with shell access, ~3 GB free RAM, ~300 MB free disk
- CPU-only setup (TEI `cpu-1.9.4` image)

## Part 1 — Install TEI

### Step 1 — Extract TEI layers from ghcr.io (no Docker)

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:huggingface/text-embeddings-inference:pull" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
MANIFEST=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/huggingface/text-embeddings-inference/manifests/cpu-1.9.4")
AMD64_DIGEST=$(echo "$MANIFEST" | python3 -c "import json,sys; d=json.load(sys.stdin); m=[x for x in d['manifests'] if x['platform']['architecture']=='amd64'][0]; print(m['digest'].split(':')[1])")
LAYERS_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/huggingface/text-embeddings-inference/manifests/sha256:$AMD64_DIGEST")
LAYER_DIGESTS=$(echo "$LAYERS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(x['digest'].split(':')[1] for x in d['layers']))")

mkdir -p /tmp/tei-layers /opt/tei-rootfs
for L in $LAYER_DIGESTS; do
  f=/tmp/tei-layers/$L.gz
  [ -s "$f" ] || curl -sfL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/huggingface/text-embeddings-inference/blobs/sha256:$L" -o "$f"
  sudo tar -xzf "$f" -C /opt/tei-rootfs 2>/dev/null || sudo tar -xf "$f" -C /opt/tei-rootfs
done
```

### Step 2 — Clean library directory (only MKL + Intel OpenMP)

Using the image's full rootfs libs in LD_LIBRARY_PATH conflicts with the host glibc. Copy only what's needed:

```bash
sudo mkdir -p /opt/tei-libs
for so in libmkl_avx2.so.2 libmkl_avx512.so.2 libmkl_core.so.2 libmkl_def.so.2 \
          libmkl_intel_lp64.so.2 libmkl_intel_thread.so.2 \
          libmkl_vml_avx2.so.2 libmkl_vml_avx512.so.2 libmkl_vml_def.so.2; do
  sudo cp -a /opt/tei-rootfs/usr/local/lib/$so /opt/tei-libs/
done
# Intel OpenMP: the binary wants libiomp5.so; image ships it as libomp.so.5
sudo cp -a /opt/tei-rootfs/usr/lib/llvm-14/lib/libomp.so.5 /opt/tei-libs/
sudo ln -sf libomp.so.5 /opt/tei-libs/libiomp5.so
```

### Step 3 — Model: bge-m3 int8, local directory

| Model | Context | Pooling | Russian | Verdict |
|-------|---------|---------|---------|---------|
| **BAAI/bge-m3 int8** | 8192 tokens | CLS | Excellent (MIRACL SOTA) | **use this** |
| intfloat/multilingual-e5-large | 512 tokens | mean | Good | truncates 1800-char segments — don't |

e5-large's 512-token limit silently truncates Vellum's 1800-char memory segments. bge-m3's 8192 context never does. Both are 1024-dim, so no qdrant collection recreate.

Quantize: take config/tokenizer from `BAAI/bge-m3`, ONNX from `Xenova/bge-m3` (`model_int8.onnx` renamed to `onnx/model.onnx`), into a local dir — TEI loads it offline, no HF download at start:

```bash
sudo mkdir -p /var/lib/tei/models/bge-m3-int8/onnx
cd /var/lib/tei/models/bge-m3-int8
sudo curl -sLO https://huggingface.co/BAAI/bge-m3/resolve/main/config.json
sudo curl -sLO https://huggingface.co/BAAI/bge-m3/resolve/main/tokenizer.json
sudo curl -sLO https://huggingface.co/BAAI/bge-m3/resolve/main/tokenizer_config.json
sudo curl -sLO https://huggingface.co/BAAI/bge-m3/resolve/main/special_tokens_map.json
sudo curl -sL https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx -o onnx/model.onnx
```

Then `--model-id /var/lib/tei/models/bge-m3-int8` in the unit. (Downloading full fp32 BAAI/bge-m3 from HF on first start works too, but doubles RAM and load time.)

### Step 4 — systemd unit

Critical gotchas baked in:

- **NO LD_PRELOAD** — the image's `libfakeintel.so` doesn't exist in extracted layers; setting it segfaults on model load.
- **MKL_ENABLE_INSTRUCTIONS=AVX2** — AVX512_E4 segfaults this stack even when the CPU supports AVX512f.
- **RAYON_NUM_THREADS does NOT cap CPU.** MKL spawns its own OpenMP threads — set **OMP_NUM_THREADS and MKL_NUM_THREADS** too, or TEI eats 324% CPU while RAYON sits at 2.
- **--max-batch-tokens 2048** — without it, TEI's warmup allocates a ~10.8 GB attention arena sized by max_batch_tokens. With it, RSS stays ~2.4 GB.
- **--max-client-batch-size 64** — Vellum's concept-page reembed sends batches of 50 > TEI's default 32 and fails without this.

```bash
sudo mkdir -p /var/lib/tei/data
cat > /tmp/tei.service <<'UNIT'
[Unit]
Description=Text Embeddings Inference (bge-m3 int8)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vellum
ExecStart=/opt/tei-rootfs/usr/local/bin/text-embeddings-router \
  --model-id /var/lib/tei/models/bge-m3-int8 \
  --port 8081 --hostname 127.0.0.1 --json-output \
  --max-client-batch-size 64 --max-batch-tokens 2048
Environment=HUGGINGFACE_HUB_CACHE=/var/lib/tei/data
Environment=LD_LIBRARY_PATH=/opt/tei-libs
Environment=MKL_ENABLE_INSTRUCTIONS=AVX2
Environment=RAYON_NUM_THREADS=4
Environment=OMP_NUM_THREADS=4
Environment=MKL_NUM_THREADS=4
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
sudo cp /tmp/tei.service /etc/systemd/system/tei.service
sudo systemctl daemon-reload && sudo systemctl enable --now tei.service
```

Changing thread count later: drop-in at `/etc/systemd/system/tei.service.d/threads.conf` + restart. A cron day/night thread switcher is not worth it — we removed ours; pick one number (4 on a 4-core box) and leave it.

### Step 5 — Verify

```bash
curl -s http://127.0.0.1:8081/health        # "OK"
curl -s http://127.0.0.1:8081/info | python3 -m json.tool
# pooling: cls, max_input_length: 8192, dimensions: 1024, max_client_batch_size: 64
curl -s -X POST http://127.0.0.1:8081/v1/embeddings -H "Content-Type: application/json" \
  -d '{"input":["привет мир","hello world"],"model":"/var/lib/tei/models/bge-m3-int8"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('vectors:',len(d['data']),'dim:',len(d['data'][0]['embedding']))"
```

### Step 6 — Switch Vellum config and restart

```bash
assistant config set memory.embeddings.provider custom
assistant config set memory.embeddings.baseUrl http://127.0.0.1:8081/v1
assistant config set memory.embeddings.customModel /var/lib/tei/models/bge-m3-int8
assistant config set memory.embeddings.customDimensions 1024
sudo -u vellum env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart vellum-juno.service
ps -eo args | grep "embed-worke[r]" || echo "NO LOCAL EMBED WORKERS — TEI active"
```

## Part 2 — Re-index everything (this is where it breaks)

A backend switch does NOT re-embed existing data, and **the obvious re-embed path is broken in three independent ways**. Read this whole part before wiping anything.

### First: know which memory tier is live

`assistant config get memory.v3` → `{ "live": true }` means **v3**. Under v3:

- **`embed_segment` jobs are no-ops.** Retired v1 engine; the worker discards them via the `isMemoryV1Active` guard (`V1_QDRANT_JOB_TYPES` in jobs-worker.ts). We ran 49,407 "completed" embed_segment jobs overnight — they embedded NOTHING. Never measure progress by them.
- The old v1 dense collection has no writers. Don't bother re-filling it.

### Collections and who fills them (v3)

| Collection | Filled by | Cadence |
|---|---|---|
| `memory_v2_concept_pages` | `embed_concept_page` jobs fanned out by `memory_v2_reembed` (one job per page slug; skills/CLI pages also land here) | `assistant memory v2 reembed` |
| `memory_v3_sections` | `memory_v3_maintain` — **incremental**: tops up only sections missing from the dense store | every 6 h |
| `messages_lexical` | `index_message_lexical` jobs, enqueued at **message finalization only** | live traffic |

Get true targets from disk, not stale notes: `ls workspace/memory/concepts/*.md | wc -l` (real count was 58 when old notes said 240).

### Failure mode 1: `database is locked` kills backfill chains

`classifyError` (persistence/job-utils.ts) treats `database is locked` as **fatal** (its retryable list is timeouts, 429/5xx, ECONN*). Then `failMemoryJob(..., {maxAttempts:1})` dead-letters it instantly and the chain (each backfill enqueues the next) dies. Daemon + memory worker share `assistant-memory.db` with busy_timeout 5 s — under CPU saturation/steal it trips.

**Fix (local patch, backup first, re-apply after EVERY vellum upgrade):** in `classifyError`, first branch:

```ts
if (
  err instanceof Error &&
  (/database is locked|SQLITE_BUSY/i.test(err.message) ||
    /^SQLITE_(BUSY|IOERR)/.test(String((err as any).code ?? "")))
) {
  return "retryable";
}
```

The patch only affects processes started after it — restart the memory worker: `assistant memory worker stop && assistant memory worker start`. **Never `kill` the memory worker — the daemon does NOT respawn it.** When checking with pgrep use the `[p]attern` trick or you match your own shell.

### Failure mode 2: backfill "completes" but nothing re-embeds

`backfillJob` walks `messages` via a checkpoint (`memory:backfill:last_*` in memory_checkpoints) and calls `indexMessageNow` per message, which **skips enqueueing when the segment's sha256 `content_hash` matches** the stored one. Wiping qdrant does not clear hashes. `force:true` only resets the checkpoint; it does NOT bypass the hash check (chained links carrying `{}` is by design, not a bug).

To truly re-embed segments (v1 tier only — pointless under v3):

```sql
UPDATE memory_segments SET content_hash = NULL;
-- then enqueue one backfill {"force":true}
```

### Failure mode 3: messages_lexical stays empty — no backfill restores it

`index_message_lexical` fires only on finalization of NEW messages. To re-index all history (sparse BM25 = local compute, no TEI, cheap, ~12k jobs drain in tens of minutes):

```sh
DB=<workspace>/data/db/assistant-memory.db
MAIN=<workspace>/data/db/assistant.db
NOW=$(date +%s%3N)
sqlite3 "$DB" <<EOF
ATTACH '$MAIN' AS chatdb;   -- alias must NOT be 'main' (that's the memory db's own schema)
INSERT OR IGNORE INTO memory_jobs (id,type,payload,status,attempts,deferrals,run_after,created_at,updated_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
 'index_message_lexical', json_object('messageId', m.id),
 'pending',0,0,$NOW,$NOW,$NOW
FROM chatdb.messages m WHERE m.finalized=1;
SELECT changes();
EOF
```

### The correct full re-index order (v3)

1. Apply the classifyError patch + restart memory worker (failure mode 1).
2. Wipe qdrant collections.
3. `assistant memory v2 reembed` → fills `memory_v2_concept_pages` (target = count of `memory/concepts/*.md`, plus skill/CLI pages).
4. Enqueue the lexical SQL above → fills `messages_lexical`.
5. Let the 6-hourly `memory_v3_maintain` top up `memory_v3_sections` (incremental; or enqueue one manually).
6. Skip `embed_segment` entirely — v1 fiction.

### Resuming a dead chain

Enqueue `backfill` with payload `{}` (NO force) — the checkpoint resumes where it died. `force:true` restarts from message zero.

### Diagnostics cheat-sheet

```sql
SELECT type,status,count(*) FROM memory_jobs WHERE status IN ('pending','running') GROUP BY 1,2;
SELECT type,last_error,count(*) FROM memory_jobs WHERE status='failed'
  AND updated_at > (strftime('%s','now')-3600)*1000 GROUP BY 1,2;
SELECT id,status,attempts,last_error,datetime(updated_at/1000,'unixepoch') FROM memory_jobs
  WHERE type='backfill' ORDER BY created_at DESC LIMIT 5;
SELECT count(*), sum(content_hash IS NOT NULL) FROM memory_segments;
```

Qdrant points: `curl -s localhost:6333/collections/<name> | jq .result.points_count`. TEI health: `curl -s localhost:8081/metrics | grep te_` — `te_request_failure{err="dropped"}` rising = raise `--max-batch-requests` (but check the queue isn't dead first; drops are a symptom, not a cause).

## Testing checklist

- [ ] `/info` shows cls pooling, 1024 dim, max_client_batch_size=64, max_input_length=8192
- [ ] `/v1/embeddings` returns correct vectors
- [ ] No `embed-worker.mjs` in `ps`; TEI RSS ~2.4 GB, CPU capped at the thread count you set
- [ ] classifyError patch applied + memory worker restarted
- [ ] `memory_v2_concept_pages` == page count on disk, `messages_lexical` == finalized message count, `memory_v3_sections` fills via maintain
- [ ] Zero failed jobs in the last hour

## Companion files

- `references/failure-modes.md` — segfault signatures, the Sep 25–26 incident record (timeline, both root causes, worker lifecycle lesson).

## Reference Files

The following reference files are available in this skill's directory. Use `file_read` to load any that are relevant to the current task:

- `references/failure-modes.md` (references/failure-modes.md)

Included Skills (immediate): none
