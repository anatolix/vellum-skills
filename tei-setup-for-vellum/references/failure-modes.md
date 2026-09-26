# TEI failure modes

## SIGSEGV (exit code 139 / signal 11)

**Symptoms:** Binary starts (logs show "Starting HTTP server" then immediately crashes with SEGV).

**Causes:**
1. `LD_PRELOAD=/usr/local/libfakeintel.so` — this file doesn't exist in extracted layers. Remove the LD_PRELOAD entirely.
2. `MKL_ENABLE_INSTRUCTIONS=AVX512_E4` — on some hosts with AVX512f, this causes immediate crash. Switch to `AVX2`.

## libiomp5.so not found

**Symptoms:** `error while loading shared libraries: libiomp5.so: cannot open shared object file`

**Cause:** The binary links Intel OpenMP. In the ghcr.io cpu image, it ships as `libomp.so.5` under `/usr/lib/llvm-14/lib/`. Create a symlink: `libiomp5.so → libomp.so.5` in the library path.

## Backend does not support batch size > 8

**Symptoms:** TEI logs "Backend does not support a batch size > 8" and forces max_batch_requests=8.

**Cause:** The ONNX runtime backend has a hard limit. This is normal — TEI still handles concurrent requests through dynamic batching within this limit.

## Model download failure (first start)

**Symptoms:** TEI logs show download errors or stalls.

**Cause:** ~2.3 GB model download from HuggingFace Hub. Slow or flaky network. Restart the service to retry. The cache dir (`/var/lib/tei/data`) persists partial downloads.

## curl: (23) Failure writing output to destination

**Symptoms:** Layer download fails mid-way.

**Cause:** Writing to a directory owned by root while running as vellum. Use a writable directory or use sudo.
# Sep 25-26 Backfill Chain Failures — Incident Record

## Timeline

- **~20:45 MSK Sep 25:** First backfill chain (bge-m3 int8) started after model switch.
- **~22:04:** Chain died. 438/11900 messages, 15/510 sections, 54/240 pages indexed.
- **~23:02:** Dead chain discovered during routine check. TEI showed 1309 dropped requests.
- **~23:08:** Re-enqueued backfill with `--max-batch-requests 512` fix. Chain died again — same `database is locked` error.
- **~23:53:** Anatoly spotted TEI at 324% CPU despite RAYON=2. OMP_NUM_THREADS + MKL_NUM_THREADS added.
- **00:13 Sep 26:** Anatoly asked for detailed root cause analysis.
- **00:19:** He ordered the fix.
- **00:21:** Patch applied, hashes reset, chain restarted.

## Root Cause A: SQLite Lock Contention (Primary)

- The daemon (PID 496517) and memory worker both write to `assistant-memory.db`.
- `busy_timeout=5000ms` — on a loaded machine with 78% steal, 5 seconds is sometimes too short.
- `classifyError` treats `database is locked` as fatal (not in retryable list).
- `failMemoryJob(..., { maxAttempts: 1 })` kills the job on first lock contention.
- The next chain link (`enqueueJob` for backfill) is called outside the handler's transaction — if the lock hits during enqueue, no successor is spawned.

## Root Cause B: Stale Content Hash (After Model Switch)

- `indexMessageNow` checks each segment's `sha256(content_hash)` before enqueuing `embed_segment`.
- If the hash matches an existing row in `memory_segments`, the job is skipped.
- Wiping Qdrant collections does NOT clear `memory_segments.content_hash`.
- Result: backfill chain runs through all messages, finds every segment "already indexed," enqueues almost no `embed_segment` jobs.

## Secondary: TEI Queue Drops

The 1309 `te_request_failure` dropped requests were a **symptom, not the cause**. The dead backfill chain had no pending `embed_segment` jobs, so there was no TEI load. The drops were from the short window after restart (23:08) before the second lock failure.

## Memory Worker Lifecycle Lesson

- `kill`-ing the memory worker (PID 497298) does NOT trigger daemon respawn.
- The correct restart procedure is `assistant memory worker stop` then `assistant memory worker start`.
- pgrep pattern: `ps -eo pid,etime,args | grep '[p]lugins/defaults/memory/w'` — the [p] trick prevents self-match.

## Patch Applied

`persistence/job-utils.ts`: `classifyError` now returns "retryable" for `database is locked`, `SQLITE_BUSY`, `SQLITE_IOERR`. Backup: `job-utils.ts.bak-sep26`. Must be re-applied after every Vellum upgrade.
