#!/usr/bin/env python3
"""Diagnostics dump of a Vellum conversation to Markdown.

Every message gets a header with vellum_id / client_message_id and, for each
shim session bound to the chat (Claude / Codex), the CLI-side correlation:
source-id map membership + matched CLI message uuid, or an explicit warning.

Read-only against assistant.db and shim state. Usage:
  diag-chat.py <conversation-id | unique prefix | exact title> [-o out.md]
No argument -> current conversation ($__CONVERSATION_ID).
"""
import argparse, datetime, json, os, re, shutil, sqlite3, sys, tempfile, glob

WS = os.environ.get("VELLUM_WORKSPACE_DIR") or os.getcwd()
DB = os.path.join(WS, "data/db/assistant.db")
HOME = os.path.expanduser("~")
CLAUDE_SESS = os.path.join(HOME, "claude-shim/sessions")
CODEX_SESS = os.path.join(HOME, "codex-shim/sessions")
CLAUDE_TRANSCRIPTS = os.path.join(HOME, ".claude/projects/-home-vellum-claude-shim")

SYNTHETIC_PATTERNS = [
    ("system_notice", re.compile(r"^\s*<system_notice>")),
    ("placeholder", re.compile(r"__PLACEHOLDER__")),
    ("context_summary", re.compile(r"^\s*(Assistant:\s*)?<context_summary>")),
]

def ts(ms):
    if not ms: return "-"
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")

def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip()

# ---------- conversation resolution ----------
def resolve(db, q):
    if not q:
        q = os.environ.get("__CONVERSATION_ID")
        if not q: sys.exit("no query and no $__CONVERSATION_ID")
    row = db.execute("select * from conversations where id=?", (q,)).fetchone()
    if not row and re.fullmatch(r"[0-9a-fA-F-]{4,36}", q):
        row = db.execute("select * from conversations where id like ? order by updated_at desc limit 1", (q + "%",)).fetchone()
    if not row:
        rows = db.execute("select * from conversations where title=? order by updated_at desc", (q,)).fetchall()
        if not rows:
            rows = db.execute("select * from conversations where lower(title) like ? order by updated_at desc limit 5", ("%" + q.lower() + "%",)).fetchall()
        if not rows: sys.exit(f"conversation not found: {q}")
        row = rows[0]
        if len(rows) > 1:
            print("WARNING: multiple matches, using most recent:", file=sys.stderr)
            for r in rows: print(f"  {r['id']}  {r['title']!r}  updated {ts(r['updated_at'])}", file=sys.stderr)
    return dict(row)

# ---------- shim discovery ----------
def load_sqlite_ids(path):
    """Return set of source_ids in a shim per-session map (via immutable copy)."""
    if not os.path.exists(path): return None, 0, None
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".sqlite"); tmp.close()
    try:
        shutil.copyfile(path, tmp.name)
        # WAL mode: live rows sit in -wal/-shm until checkpointed — copy them too,
        # otherwise a live shim's map reads as empty.
        for suf in ("-wal", "-shm"):
            if os.path.exists(path + suf):
                shutil.copyfile(path + suf, tmp.name + suf)
        con = sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)
        ids = {r[0] for r in con.execute("select distinct source_id from blocks")}
        n = con.execute("select count(*) from blocks").fetchone()[0]
        # patch 9 (Oct 5): exact Vellum id <-> CLI id pairs written by the shim itself.
        # Keyed by Vellum row id; a tool call/result is `row/<tool_call_id>` → keyed by row too.
        cli = {}
        try:
            for vid, row, part, cid, kind, fed in con.execute("select vellum_id, row_id, part, cli_id, kind, fed from cli_ids order by ts"):
                cli.setdefault(row, []).append({"vellum_id": vid, "part": part, "cli_id": cid, "kind": kind, "fed": fed})
        except sqlite3.Error:
            cli = None  # map created before patch 9: no table
        con.close()
        return ids, n, cli
    except Exception:
        return set(), 0, None
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass

def find_shims(conv_id):
    import hashlib
    out = {}
    # Both shims name the state file sha(key)+".json"; key == conversation id for
    # normal chats. Prefer the direct filename hit; fall back to scanning for
    # state files that store the key inside (claude does, codex doesn't).
    direct = hashlib.sha1(conv_id.encode()).hexdigest()
    for name, d in (("claude", CLAUDE_SESS), ("codex", CODEX_SESS)):
        if not os.path.isdir(d): continue
        files = [os.path.join(d, direct + ".json")] if os.path.exists(os.path.join(d, direct + ".json")) else []
        files += [f for f in glob.glob(os.path.join(d, "*.json")) if f not in files]
        for f in files:
            try: st = json.load(open(f))
            except Exception: continue
            direct_hit = os.path.basename(f) == direct + ".json"
            if not direct_hit and st.get("key") != conv_id: continue
            base = f[:-5]
            entry = {"state_file": f, "model": st.get("model"), "served": st.get("served"),
                     "sessionId": st.get("sessionId"), "threadId": st.get("threadId"),
                     "map_file": base + ".ids.sqlite"}
            entry["map_ids"], entry["map_rows"], entry["cli_ids"] = load_sqlite_ids(entry["map_file"])
            out[name] = entry
            break
    return out

# ---------- CLI transcripts ----------
def claude_transcript(session_id):
    """uuid -> normalized text, from the Claude CLI transcript jsonl."""
    res = {}
    if not session_id: return res
    p = os.path.join(CLAUDE_TRANSCRIPTS, session_id + ".jsonl")
    if not os.path.exists(p): return res
    for line in open(p, errors="replace"):
        try: e = json.loads(line)
        except Exception: continue
        u = e.get("uuid")
        msg = e.get("message") or {}
        content = msg.get("content")
        if isinstance(content, str): text = content
        elif isinstance(content, list):
            text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        else: text = ""
        if u and norm(text): res.setdefault(norm(text), []).append(u)
    return res

def codex_transcript(thread_id):
    """normalized text -> list of item ids, from the Codex rollout jsonl."""
    res = {}
    if not thread_id: return res
    hits = glob.glob(os.path.join(HOME, f".codex/sessions/**/rollout-*{thread_id}*.jsonl"), recursive=True)
    for p in hits:
        for line in open(p, errors="replace"):
            try: e = json.loads(line)
            except Exception: continue
            # Codex rollout lines: {"type":"response_item","payload":{"type":"message",
            # "id":"msg_...","content":[{"type":"input_text"|"output_text","text":...}]}}
            item = e.get("payload") if e.get("type") == "response_item" else None
            if not isinstance(item, dict) or item.get("type") != "message": continue
            iid = item.get("id")
            c = item.get("content") or []
            text = "\n".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else str(c)
            if iid and norm(text): res.setdefault(norm(text), []).append(iid)
    return res

def msg_text(blocks):
    parts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(parts)

def synthetic_kind(text):
    for name, rx in SYNTHETIC_PATTERNS:
        if rx.search(text or ""): return name
    return None

# ---------- rendering ----------
def render_block(b, out):
    t = b.get("type", "?") if isinstance(b, dict) else "raw"
    out.append(f"<details open><summary><code>{t}</code></summary>\n")
    if t == "text":
        out.append("\n" + (b.get("text") or "") + "\n")
    elif t == "thinking":
        meta = {k: b.get(k) for k in ("signature", "_startedAt", "_completedAt") if b.get(k)}
        out.append("\n```\n" + (b.get("thinking") or "") + "\n```\n")
        if meta: out.append(f"\n<sub>{json.dumps(meta, ensure_ascii=False)[:300]}</sub>\n")
    elif t == "tool_use":
        out.append(f"\n**tool_use** `{b.get('name')}` id=`{b.get('id')}`\n\n```json\n" +
                   json.dumps(b.get("input"), ensure_ascii=False, indent=1) + "\n```\n")
    elif t == "tool_result":
        c = b.get("content")
        if isinstance(c, list):
            c = "\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in c)
        out.append(f"\n**tool_result** tool_use_id=`{b.get('tool_use_id')}` is_error={b.get('is_error', False)}\n\n```\n{c}\n```\n")
    else:
        out.append("\n```json\n" + json.dumps(b, ensure_ascii=False, indent=1) + "\n```\n")
    out.append("\n</details>\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("-o", "--output")
    a = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    conv = resolve(db, a.query)
    cid = conv["id"]
    msgs = [dict(r) for r in db.execute(
        "select * from messages where conversation_id=? order by created_at, id", (cid,))]
    comp = [dict(r) for r in db.execute(
        "select * from conversation_compaction_events where conversation_id=? order by compacted_at", (cid,))]
    shims = find_shims(cid)
    transcripts = {
        "claude": claude_transcript(shims.get("claude", {}).get("sessionId")),
        "codex": codex_transcript(shims.get("codex", {}).get("threadId")),
    }

    out = []
    out.append(f"# Диагностика чата: {conv['title']}\n")
    out.append(f"- **conversation_id:** `{cid}`")
    out.append(f"- created: {ts(conv['created_at'])} · updated: {ts(conv['updated_at'])} · messages: **{len(msgs)}**")
    out.append(f"- inference_profile: `{conv.get('inference_profile')}` · source: `{conv.get('source')}` · type: `{conv.get('conversation_type')}`")
    if conv.get("context_summary"):
        out.append(f"- compacted: {conv.get('context_compacted_message_count')} msgs at {ts(conv.get('context_compacted_at'))}")
    roles = {}
    for m in msgs: roles[m["role"]] = roles.get(m["role"], 0) + 1
    out.append(f"- roles: " + ", ".join(f"{r} {n}" for r, n in sorted(roles.items())))
    out.append("")

    out.append("## События компакции\n")
    if comp:
        for e in comp:
            out.append(f"- `{e['id']}` at {ts(e['compacted_at'])} — {e['compacted_message_count']} сообщений, summary {len(e.get('summary') or '')} зн.")
    else:
        out.append("- нет")
    out.append("")

    out.append("## Связка с CLI-шимами\n")
    if not shims:
        out.append("⚠ Ни одна shim-сессия (claude/codex) с key == conversation_id не найдена.")
    for name, s in shims.items():
        sid = s.get("sessionId") or s.get("threadId") or "—"
        label = "sessionId" if name == "claude" else "threadId"
        out.append(f"### {name}")
        out.append(f"- {label}: `{sid}` · model: `{s.get('model')}` · served: {s.get('served')}")
        if s.get("map_ids") is None:
            out.append(f"- source-id map: ⚠ файл не найден ({s['map_file']})")
        else:
            out.append(f"- source-id map: {len(s['map_ids'])} уникальных source_id, {s['map_rows']} строк (`{s['map_file']}`)")
            cl = s.get("cli_ids")
            if cl is None:
                out.append("- cli_ids (patch 9): ⚠ таблицы нет — карта создана до патча 9, пары CLI-id только по транскрипту")
            else:
                tot = sum(len(v) for v in cl.values()); fed = sum(1 for v in cl.values() for e in v if e["kind"] == "tool_use" and e["fed"])
                calls = sum(1 for v in cl.values() for e in v if e["kind"] == "tool_use")
                out.append(f"- cli_ids (patch 9): {tot} пар, строк Vellum: {len(cl)}, tool_use: {calls} (fed {fed})")
        out.append(f"- транскрипт: {len(transcripts[name])} уникальных текстов")
    out.append("")

    out.append("---\n\n## Сообщения\n")
    out.append("| ID | Тип | Детали |")
    out.append("|:---|:---|:---|")
    warn_total = 0

    import zlib
    def crc(u): return format(zlib.crc32(u.encode()) & 0xFFFFFFFF, "08x")
    def cell(s):
        s = str(s).replace("`", "'").replace("\r", " ").replace("\n", "<br>")
        return s.replace("|", "\\|")
    def detail_cell(text, limit=1200):
        text = text or ""
        if len(text) <= limit: return cell(text)
        head, tail = text[:limit], text[limit:]
        return (cell(head) + f"<br><details><summary>…ещё {len(tail)} зн.</summary><br>" +
                cell(tail) + "</details>")

    KIND = {"text": None, "thinking": "💭 thinking", "tool_use": "🔧 вызов", "tool_result": "📥 результат",
            "ui_surface": "🖼 ui_surface", "raw": "⚙️ raw"}

    for i, m in enumerate(msgs, 1):
        try: blocks = json.loads(m["content"])
        except Exception: blocks = [{"type": "raw", "content": m["content"]}]
        if not isinstance(blocks, list): blocks = [blocks]
        text = msg_text(blocks)
        syn = synthetic_kind(text) or (None if blocks else None)
        if m["role"] == "assistant" and not blocks: syn = syn or "empty-assistant"

        nt = norm(text)
        # --- correlate once per message ---
        id_lines = [f"<b>#{i}</b> · {ts(m['created_at'])}", f"vellum: <code>{m['id']}</code>"]
        if m.get('client_message_id'):
            id_lines.append(f"client: <code>{m['client_message_id']}</code>")
        for name, s in shims.items():
            ids = s.get("map_ids")
            in_map = ids is not None and m["id"] in ids
            # patch 9: exact pairs from the shim's own cli_ids table win over text matching
            # (tool rows have no text, but they do have pairs — check pairs first)
            pairs = (s.get("cli_ids") or {}).get(m["id"])
            if not pairs and not nt:
                id_lines.append(f"{name}: — (нет текста)" + ("" if s.get("cli_ids") is None or in_map else " · ⚠ НЕТ в map"))
                continue
            if pairs:
                for e in pairs:
                    tag = e["kind"] + (f" {e['part']}" if e["part"] else "")
                    cid = e["cli_id"] or "∅"
                    fed = " · fed" if e["fed"] else ("" if e["kind"] == "reply" else " · not fed")
                    id_lines.append(f"{name} {tag}: <code>{crc(cid) if e['cli_id'] else '—'}</code> ({cid[:13]}…){fed}" if e["cli_id"] else f"{name} {tag}: ⚠ cli_id пустой{fed}")
                continue
            uuids = transcripts[name].get(nt)
            if not uuids and len(nt) >= 20:
                for t, us in transcripts[name].items():
                    if len(t) >= 20 and (nt in t or t in nt):
                        uuids = us; break
            if uuids:
                u = uuids[0]
                line = f"{name} crc: <code>{crc(u)}</code> ({u[:13]}…) · по тексту"
                if len(uuids) > 1: line += f" ×{len(uuids)}"
                id_lines.append(line if in_map else "⚠ " + line + " · НЕТ в map")
            elif in_map:
                id_lines.append(f"{name}: в map · ⚠ нет в транскрипте")
            else:
                if syn:
                    id_lines.append(f"{name}: synthetic ({syn}) — без CLI-пары")
                else:
                    id_lines.append(f"{name}: ⚠ НЕТ в map, НЕТ в транскрипте")
                    warn_total += 1
        if not shims:
            id_lines.append("⚠ shim-сессии не найдены")
        if m.get('finalized') != 1:
            id_lines.append(f"finalized: {m.get('finalized')}")
        ids_cell = "<br>".join(id_lines)

        role_kind = "👤 пользователь" if m["role"] == "user" else ("🤖 ассистент" if m["role"] == "assistant" else f"⚙️ {m['role']}")
        if not blocks:
            out.append(f"| {ids_cell} | {role_kind} (пустое) | — |")
            continue
        # One DB row = one table row: blocks glued into the details cell with a
        # visible separator, kinds stacked in the type cell.
        kinds, dets = [], []
        for b in blocks:
            if not isinstance(b, dict): b = {"type": "raw", "content": b}
            bt = b.get("type", "?")
            if bt == "text":
                kinds.append(role_kind if not syn else f"⚙️ системное ({syn})")
                dets.append(detail_cell(b.get("text") or ""))
            elif bt == "thinking":
                kinds.append("💭 thinking"); dets.append(detail_cell(b.get("thinking") or ""))
            elif bt == "tool_use":
                kinds.append(f"🔧 вызов <code>{b.get('name')}</code>")
                dets.append(f"tool_use_id: <code>{b.get('id')}</code><br>" +
                            detail_cell(json.dumps(b.get("input"), ensure_ascii=False, indent=1), 800))
            elif bt == "tool_result":
                c = b.get("content")
                if isinstance(c, list):
                    c = "\\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in c)
                kinds.append("📥 результат" + (" ❗ошибка" if b.get("is_error") else ""))
                dets.append(f"tool_use_id: <code>{b.get('tool_use_id')}</code><br>" + detail_cell(str(c), 800))
            else:
                kinds.append(KIND.get(bt, f"⚙️ {bt}"))
                dets.append(detail_cell(json.dumps(b, ensure_ascii=False, indent=1), 800))
        sep = "<br>──────────<br>"
        out.append(f"| {ids_cell} | {'<br>'.join(kinds)} | {sep.join(dets)} |")

    out.append(f"## Итог\n\n- сообщений: {len(msgs)}, предупреждений о полном отсутствии CLI-связки (не synthetic): **{warn_total}**\n")

    dest = a.output or os.path.join(WS, "scratch", f"diag-{cid[:8]}.md")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f: f.write("\n".join(out))
    print(dest)

if __name__ == "__main__":
    main()
