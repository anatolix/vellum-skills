// Per-session map: Vellum persisted row id  <->  content hash of the block the
// shim rendered from it. Lets a shim tell "same message, rewritten rendering"
// (compaction stripped <memory>/<channel_capabilities>, a card appeared or
// vanished, /clean) from "genuinely new message" — instead of guessing from a
// bare text hash and tail-matching.
//
// Vellum (local patch 8) sends, on the openai-compatible body only, the
// non-standard field
//   _vellum: { version: 1, messages: [{ index, source_ids: [...] }] }
// indexed against body.messages. One wire message may carry several ids
// (history-repair merged consecutive same-role messages) and several wire
// messages may share one id (tool-result fan-out). Everything here is
// best-effort: no _vellum, or a block without ids, means "unknown" and the
// caller falls back to its hash-only rule.
//
// Storage: one small SQLite file per CLI session, owned by that shim process
// alone (no shared DB, no cross-process locks). Shared verbatim by the Claude
// shim (server-v3.js) and the Codex shim (server-v2.js).
import { Database } from "bun:sqlite";

/** Annotate body.messages in place: m._sourceIds = [...] from body._vellum. */
// v1: plain row ids. v2 (Vellum patch 8e): ids may be composite `row/part` — one entry per
// wire message even when several render from one row (tool fan-out, hook-guidance tail), and
// an empty assistant row exports its id too. Both read the same way here: opaque strings.
export function attachSourceIds(messages, vellum) {
  if (!Array.isArray(messages) || !vellum || !(vellum.version === 1 || vellum.version === 2) || !Array.isArray(vellum.messages)) return 0;
  let n = 0;
  for (const e of vellum.messages) {
    const m = messages[e?.index];
    if (!m || !Array.isArray(e.source_ids) || !e.source_ids.length) continue;
    m._sourceIds = e.source_ids.map(String);
    n++;
  }
  return n;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  source_id  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  kind       TEXT,
  len        INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (source_id, hash)
);
CREATE INDEX IF NOT EXISTS blocks_sid ON blocks(source_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export class SourceIdMap {
  /** @param {string} path file path, or ":memory:" for one-use chats */
  constructor(path) {
    this.path = path;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    this.qHashes = this.db.query("SELECT hash FROM blocks WHERE source_id = ?");
    this.qUpsert = this.db.query(
      "INSERT INTO blocks (source_id, hash, kind, len, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(source_id, hash) DO UPDATE SET last_seen = excluded.last_seen");
    this.qCount = this.db.query("SELECT COUNT(DISTINCT source_id) AS ids, COUNT(*) AS rows FROM blocks");
    this.markMany = this.db.transaction((blocks, hashes, now) => {
      let n = 0;
      blocks.forEach((b, i) => {
        for (const id of b.sourceIds || []) { this.qUpsert.run(id, hashes[i], b.kind || b.role || null, b.text?.length ?? null, now, now); n++; }
      });
      return n;
    });
  }

  /**
   * "seen"      every id of the block is known with exactly this hash
   * "rewritten" every id is known, but at least one never had this hash
   * "new"       at least one id has never been fed to this session
   * "unknown"   block carries no ids (no _vellum) — use the hash-only rule
   */
  classify(block, hash) {
    const ids = block?.sourceIds;
    if (!ids || !ids.length) return "unknown";
    let rewritten = false;
    for (const id of ids) {
      const rows = this.qHashes.all(id);
      if (!rows.length) return "new";
      if (!rows.some(r => r.hash === hash)) rewritten = true;
    }
    return rewritten ? "rewritten" : "seen";
  }

  classifyAll(blocks, hashes) { return blocks.map((b, i) => this.classify(b, hashes[i])); }

  /** Record every block of this request as fed (new, rewritten and repeated alike). */
  markFed(blocks, hashes) { return this.markMany(blocks, hashes, Date.now()); }

  /** Session restarted from scratch: the CLI forgot everything, so do we. */
  reset() { this.db.exec("DELETE FROM blocks"); }

  stats() { return this.qCount.get(); }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}

/** No-op map for chats that must not touch disk (one-use) when ids are unwanted. */
export const NULL_SOURCE_ID_MAP = {
  classify() { return "unknown"; }, classifyAll(blocks) { return blocks.map(() => "unknown"); },
  markFed() { return 0; }, reset() {}, stats() { return { ids: 0, rows: 0 }; }, close() {},
};

/** Summarise a classification array for a log line; null when nothing had ids. */
export function describeClasses(classes) {
  const c = { seen: 0, rewritten: 0, new: 0, unknown: 0 };
  for (const k of classes) c[k] = (c[k] || 0) + 1;
  if (c.seen + c.rewritten + c.new === 0) return null;
  return `ids: seen=${c.seen} rewritten=${c.rewritten} new=${c.new}${c.unknown ? ` noid=${c.unknown}` : ""}`;
}

/**
 * Assistant turns of the wire history as id-only blocks. Never fed to a CLI (the CLI
 * produced them itself); recorded so every Vellum row of the conversation — user,
 * assistant and tool — is tracked in the per-session map.
 */
export function assistantBlocksOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m?.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content
      : (m.content || []).map(p => (p && p.type === "text" ? p.text : "")).join("\n");
    const calls = (m.tool_calls || []).map(c => `${c.id || ""}:${c.function?.name || ""}`).join(",");
    if (!text.trim() && !calls) continue;
    out.push({ kind: "assistant", id: calls, text: text || "", sourceIds: m._sourceIds || null });
  }
  return out;
}

/**
 * Per-role id coverage of the wire messages (system excluded). Returns
 * { counts: {role: [withIds, total]}, missing: n, summary } — summary is null when
 * every non-system message carried ids.
 */
function textOf(m) {
  const raw = m.content ?? m.text ?? "";
  return typeof raw === "string" ? raw : (raw || []).map(p => (p && p.type === "text" ? p.text : "")).join("\n");
}
export function idCoverage(messages) {
  const counts = {};
  const details = []; // one entry per message without ids: where it sits and what it starts with
  let missing = 0, total = 0;
  (messages || []).forEach((m, index) => {
    const r = m?.role;
    if (!r || r === "system" || r === "developer") return;
    // Vellum-built, no DB row: the compaction summary that replaces the head.
    if (r === "assistant" && /^\s*(Assistant:\s*)?<context_summary>/.test(textOf(m))) return;
    const c = counts[r] || (counts[r] = [0, 0]);
    c[1]++; total++;
    if (Array.isArray(m._sourceIds) && m._sourceIds.length) { c[0]++; return; }
    missing++;
    const raw = m.content ?? m.text ?? "";
    const text = typeof raw === "string" ? raw : (raw || []).map(p => (p && (p.text || p.content)) || "").join(" ");
    details.push({ index, role: r, len: text.length, head: text.replace(/\s+/g, " ").trim().slice(0, 60) });
  });
  // `none`: nothing in the request carried ids (profile not opted in / Vellum patch not live).
  // `summary`: "<missing> из <total> (role n, ...)" — counts of messages WITHOUT ids.
  const none = total > 0 && missing === total;
  const summary = missing
    ? `${missing} из ${total} (${Object.entries(counts).filter(([, [w, t]]) => w < t).map(([r, [w, t]]) => `${r} ${t - w}`).join(", ")})`
    : null;
  return { counts, missing, total, none, summary, details };
}

/** Log-friendly one-liner of the messages without ids. */
export function describeMissing(coverage) {
  return (coverage?.details || []).map((d) => `#${d.index} ${d.role} ${d.len}ch "${d.head}"`).join(" | ");
}
