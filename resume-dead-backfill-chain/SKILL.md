---
name: resume-dead-backfill-chain
description: Diagnose and recover a dead or incomplete Vellum memory re-embed after an embedding-model switch. Covers the SQLite-lock fatal misclassification, the content_hash skip trap, v1/v3 tier differences, and per-collection fill paths. Use when memory collections are empty/partial after a model change, memory_jobs shows failed backfills, or semantic search seems to have lost old content.
---

# Resume / repair memory indexing after an embedding-model switch

Verified Sep 25–26, 2026 on Vellum 0.12.4 self-hosted, TEI backend, memory **v3 live**.

## First: know which tier is live

`assistant config get memory.v3` → `{ "live": true }` means **v3**. Under v3:

- **`embed_segment` jobs are no-ops.** They belong to the retired v1 engine; the worker discards them via the `isMemoryV1Active` guard (`V1_QDRANT_JOB_TYPES` in `jobs-worker.ts`). A "completed" embed_segment under v3 embedded NOTHING. Do not measure re-embed progress by them, and do not expect segment vectors in Qdrant.
- The v1 dense collection (`config.memory.qdrant.collection`) has no writers under v3.

## Collections and who fills them (v3)

| Collection | Filled by | Cadence |
|---|---|---|
| `memory_v2_concept_pages` | `embed_concept_page` jobs, fanned out by `memory_v2_reembed` (one job per page slug) | on demand / `assistant memory v2 reembed` |
| `memory_v3_sections` | `memory_v3_maintain` — **incremental**: only sections missing from the dense store | every **6 h** |
| `messages_lexical` | `index_message_lexical` jobs, enqueued at **message finalization only** | live traffic |

**Get true targets from disk, not from stale memory**: `ls workspace/memory/concepts/*.md | wc -l` is the real concept-page target (it was 58 when stale notes said 240).

## Failure mode 1: `database is locked` kills backfill chains

`classifyError` (persistence/job-utils.ts) treats `database is locked` as **fatal** (not in its retryable list: timeouts, 429/5xx, ECONN*). Then `failMemoryJob(..., {maxAttempts: 1})` dead-letters it instantly; the chain (each backfill enqueues the next) dies. Two writers (daemon + memory worker) share `assistant-memory.db`, busy_timeout 5 s — under CPU saturation/steal it trips.

**Fix (local patch, re-apply after every upgrade):** in `classifyError`, first branch:

```ts
if (
  err instanceof Error &&
  (/database is locked|SQLITE_BUSY/i.test(err.message) ||
    /^SQLITE_(BUSY|IOERR)/.test(String((err as any).code ?? "")))
) {
  return "retryable";
}
```

Backup before patching. The patch only takes effect in processes started AFTER it — restart the memory worker: `assistant memory worker stop && assistant memory worker start`. **Never `kill` the memory worker** — the daemon does NOT respawn it. When pgrep-checking, use the `[p]attern` trick or you match your own shell.

## Failure mode 2: backfill completes but nothing re-embeds

`backfillJob` walks `messages` via a checkpoint (`memory:backfill:last_*` in memory_checkpoints) and calls `indexMessageNow` per message. That function **skips enqueueing when the segment's sha256 `content_hash` matches** the stored one — and wiping Qdrant does not touch those hashes. `force:true` only resets the checkpoint; it does NOT bypass the hash check (losing `force` on chained links is by design, not a bug).

**To truly re-embed segments (v1 tier only — pointless under v3):**
```sql
UPDATE memory_segments SET content_hash = NULL;
-- then enqueue one backfill {"force":true}
```

Under v3 the equivalent real actions are:
- concept pages: `assistant memory v2 reembed`
- v3 sections: wait for the 6-hourly `memory_v3_maintain` (or enqueue it) — it tops up missing sections incrementally
- messages_lexical: see below

## Failure mode 3: messages_lexical empty after wipe — backfill will NOT restore it

`index_message_lexical` is only enqueued on finalization of NEW messages. Old messages never get lexical (sparse BM25) points from any backfill. To re-index all history (sparse = local compute, no TEI, cheap):

```sh
DB=<workspace>/data/db/assistant-memory.db
MAIN=<workspace>/data/db/assistant.db
NOW=$(date +%s%3N)
sqlite3 "$DB" <<EOF
ATTACH '$MAIN' AS chatdb;   -- alias must NOT be 'main' (already the memory db's schema)
INSERT OR IGNORE INTO memory_jobs (id,type,payload,status,attempts,deferrals,run_after,created_at,updated_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
 'index_message_lexical', json_object('messageId', m.id),
 'pending',0,0,$NOW,$NOW,$NOW
FROM chatdb.messages m WHERE m.finalized=1;
SELECT changes();
EOF
```

~12k jobs drain in tens of minutes.

## Resuming a dead chain correctly

Enqueue `backfill` with payload `{}` (NO `force`) — the checkpoint resumes where it died. `force:true` restarts from message zero.

## Diagnostics cheat-sheet

```sql
-- queue
SELECT type,status,count(*) FROM memory_jobs WHERE status IN ('pending','running') GROUP BY 1,2;
-- recent failures with reasons
SELECT type,last_error,count(*) FROM memory_jobs WHERE status='failed'
  AND updated_at > (strftime('%s','now')-3600)*1000 GROUP BY 1,2;
-- backfill chain state
SELECT id,status,attempts,last_error,datetime(updated_at/1000,'unixepoch') FROM memory_jobs
  WHERE type='backfill' ORDER BY created_at DESC LIMIT 5;
-- hash coverage
SELECT count(*), sum(content_hash IS NOT NULL) FROM memory_segments;
```

Qdrant points: `curl -s localhost:6333/collections/<name> | jq .result.points_count`. TEI metrics: `curl -s localhost:8081/metrics | grep te_` (`te_request_failure{err="dropped"}` rising = raise `--max-batch-requests`).
