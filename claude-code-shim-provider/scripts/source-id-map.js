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
// v3 (Vellum patch 9): adds `reply_id` — the row Vellum reserved for the reply to this very request
// (see replyIdOf), so the shim can key what it generates before Vellum ever echoes it back.
export function attachSourceIds(messages, vellum) {
  if (!Array.isArray(messages) || !vellum || !(vellum.version >= 1 && vellum.version <= 3) || !Array.isArray(vellum.messages)) return 0;
  let n = 0;
  for (const e of vellum.messages) {
    const m = messages[e?.index];
    if (!m || !Array.isArray(e.source_ids) || !e.source_ids.length) continue;
    m._sourceIds = e.source_ids.map(String);
    n++;
  }
  return n;
}

/** `_vellum.reply_id` (v3+): the Vellum row id the reply of this request will be stored under; null when absent. */
export function replyIdOf(vellum) {
  const id = vellum && vellum.version >= 3 ? vellum.reply_id : null;
  return typeof id === "string" && id.length ? id : null;
}

/** Composite `row/part` → row; a plain id is its own row. */
export function rowOf(id) { const i = String(id).indexOf("/"); return i < 0 ? String(id) : String(id).slice(0, i); }
/** Composite `row/part` → part; null for a plain row id. */
export function partOf(id) { const i = String(id).indexOf("/"); return i < 0 ? null : String(id).slice(i + 1); }

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
-- Vellum id <-> CLI id for everything this session generated or consumed (patch 9).
--   vellum_id  reply row "<row>", tool call "<reply_row>/<tool_call_id>" or
--              tool result "<result_row>/<tool_call_id>" ("?/<id>" when the result carried no id)
--   part       the tool_call_id for calls and results; NULL for reply text
--   cli_id     Claude: CLI message uuid; Codex: item/call id — '' when the CLI exposed none
--   kind       reply | tool_use | tool_result
--   fed        1 once the matching result reached the CLI natively (tool_use/tool_result)
CREATE TABLE IF NOT EXISTS cli_ids (
  vellum_id TEXT NOT NULL,
  row_id    TEXT NOT NULL,
  part      TEXT,
  cli_id    TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL,
  fed       INTEGER NOT NULL DEFAULT 0,
  session   TEXT,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (vellum_id, cli_id)
);
CREATE INDEX IF NOT EXISTS cli_ids_part ON cli_ids(part);
CREATE INDEX IF NOT EXISTS cli_ids_row ON cli_ids(row_id);
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
    this.qCliIns = this.db.query(
      "INSERT INTO cli_ids (vellum_id, row_id, part, cli_id, kind, fed, session, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(vellum_id, cli_id) DO UPDATE SET fed = MAX(fed, excluded.fed), session = COALESCE(excluded.session, session)");
    this.qCliFed = this.db.query("UPDATE cli_ids SET fed = 1 WHERE part = ?");
    this.qCliIsFed = this.db.query("SELECT 1 FROM cli_ids WHERE part = ? AND fed = 1 LIMIT 1");
    this.qCliCount = this.db.query("SELECT COUNT(*) AS n, SUM(kind = 'tool_use') AS calls, SUM(kind = 'tool_use' AND fed = 1) AS fed FROM cli_ids");
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
  reset() { this.db.exec("DELETE FROM blocks"); this.db.exec("DELETE FROM cli_ids"); }

  stats() { return { ...this.qCount.get(), cli: this.qCliCount.get() }; }

  /** One generated/consumed item: vellumId (`row` or `row/part`), its CLI-side id, kind. */
  recordCli(vellumId, cliId, kind, { part = partOf(vellumId), fed = 0, session = null } = {}) {
    if (!vellumId) return false;
    this.qCliIns.run(String(vellumId), rowOf(vellumId), part ?? null, cliId == null ? "" : String(cliId), kind, fed ? 1 : 0, session ?? null, Date.now());
    return true;
  }

  /**
   * A tool result for `toolCallId` reached the CLI natively. Records it under the result row's
   * composite id (from the wire message's ids; `?/<id>` when it carried none) and flips the
   * matching tool_use to fed. Replaces the old in-memory consumed-set: survives a shim restart.
   */
  recordResultFed(sourceIds, toolCallId, cliId = "") {
    if (!toolCallId) return;
    const own = (sourceIds || []).find((id) => partOf(id) === toolCallId) || `?/${toolCallId}`;
    this.recordCli(own, cliId, "tool_result", { part: toolCallId, fed: 1 });
    this.qCliFed.run(toolCallId);
  }

  /**
   * User blocks fed to the CLI in one turn, paired with the CLI-side id of the entry that holds
   * them (Claude: the transcript user uuid; Codex: the userMessage item id, or `turn:<id>` when
   * the app-server exposed no item). One row per Vellum id of every fed block.
   */
  recordUserFed(blocks, cliId, session = null) {
    let n = 0;
    for (const b of blocks || []) for (const id of b?.sourceIds || []) n += this.recordCli(id, cliId, "user", { part: partOf(id), fed: 1, session }) ? 1 : 0;
    return n;
  }

  /** Did a result for this tool call already reach the CLI (any kind, any session restart)? */
  isPartFed(toolCallId) { return !!toolCallId && !!this.qCliIsFed.get(toolCallId); }

  /**
   * Claude CLI stream-json `assistant` message for the reply Vellum reserved as `replyId`:
   * text blocks → `replyId`, each tool_use → `replyId/<tool_use_id>`; cli_id = the message uuid.
   */
  recordClaudeAssistant(replyId, msg) {
    if (!replyId || !msg) return 0;
    const uuid = msg.uuid || "";
    let n = 0;
    for (const b of msg.message?.content || []) {
      if (b?.type === "tool_use" && b.id) n += this.recordCli(`${replyId}/${b.id}`, uuid, "tool_use", { part: b.id, session: msg.session_id }) ? 1 : 0;
      else if (b?.type === "text" && b.text) n += this.recordCli(replyId, uuid, "reply", { part: null, session: msg.session_id }) ? 1 : 0;
    }
    return n;
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}

/** No-op map for chats that must not touch disk (one-use) when ids are unwanted. */
export const NULL_SOURCE_ID_MAP = {
  classify() { return "unknown"; }, classifyAll(blocks) { return blocks.map(() => "unknown"); },
  markFed() { return 0; }, reset() {}, stats() { return { ids: 0, rows: 0, cli: { n: 0, calls: 0, fed: 0 } }; }, close() {},
  recordCli() { return false; }, recordResultFed() {}, isPartFed() { return false; }, recordClaudeAssistant() { return 0; }, recordUserFed() { return 0; },
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
