# In-chat shim diagnostics (red notices) — shared by claude-shim v3 and codex-shim v2

Deployed Oct 3 2026. Source: `scripts/notice-transport.js` (byte-identical in both skills).
Replaces the older in-text notices (claude: ```diff fence; codex: italic `_⚙ шим: …_`).

## Why a fake tool call
Vellum web renders a FAILED tool call's `activity` label as a separate red/orange line
when it sits between two assistant text segments. Proved Oct 3 with `bash false` and
activity text "этот цвет красный". So a diagnostic is delivered as a call to the deliberately
UNREGISTERED tool `__shim_notice__` with `arguments: {"activity": "<text>"}`, bracketed by a
`-------------------` text separator. Vellum's unknown-tool guard returns an error result without
executing anything. That error is what turns the line red. No shell, no skill, no Vellum patch.

## Flow (one notice = one extra HTTP round trip, zero extra inference)
1. The shim core emits `data: {"shim_notice": "..."}` SSE frames (claude: `onMsg({type:"shim_notice"})`,
   codex: `res.write(noticeFrame(txt))`).
2. `NoticeTransport.fetch` wraps the HTTP handler. The FIRST notice seen before any visible model output
   ends the HTTP response right there: separator + one `__shim_notice__` call + `finish_reason: tool_calls`.
   The upstream SSE reader is parked (`pending`, TTL 15 min), NOT cancelled.
3. Vellum answers with a `role: tool` "Unknown tool" result. The transport recognises the call id
   (`call_shim_notice_*`), resumes the SAME parked reader, emits the next notice or the model output.
4. `cleanNotices()` strips synthetic calls and results from every later request, so the model never sees
   them and the CLI/thread history hashes stay stable.

## Rules
- Notices go only on requests that are tool-bearing, keyed, not `router-oneuse-*`, not `tool_choice: none`,
  not `response_format`. Everything else is log-only (`[shim-notice] …` in journal). This keeps JSON/structured
  callers and the shim-router cascade clean.
- A notice that arrives after visible output (late) is queued per key and shown on the next request.
  Queued transport notices are memory-only. Claude `pendingNotices` (park/evict/die) are persisted in the session file.
- `SHIM_NOTICE_FMT=tool` is the default; any other value = log-only.
- Keep texts SHORT. The web UI truncates the label to roughly one line (~60–70 chars visible).
  Format: `[claude-shim|codex-shim] <Event>: <model>; <essentials>`. No timestamps, no PIDs, no
  reasons that duplicate the event name. Full detail goes to the journal.

## Events
| claude-shim | codex-shim |
|---|---|
| `Старт: <model>; с нуля / из файла` (+`одноразовый` for oneshot) | `Старт: <model>; с нуля / из файла; видено=N` |
| `CLI завершён: <model>; <reason>` (park/evict/idle/death, shown on next request) | `CLI завершён: <model>; код=N` (shared app-server exit) |
| `Смена модели: A → B` | `Сессия заменена: A → B / инструменты 21→20 −x +y / промпт ±N симв., строка L / порядок инструментов` |
| `Большой контекст: +N блоков; видено=M/T` (N > `SHIM_FULL_HIST_MIN`, default 8) | same, N > `SHIM_MAX_FEED` (8); fresh AND existing threads |
| `История изменилась: +K до хвоста; …` / `История не совпала: отправляю=N; видено=0/T` | — |
| `Ошибка CLI`, `Восстановление не удалось` | `Ошибка CLI`, `Восстановление не удалось`, `Потеря tool call: N` |

"Большой контекст" and "История не совпала" can both fire on one turn. That is intended: history can
match partially, and the two notices carry different facts.
"видено" = blocks the CLI session already has, which is NOT a provider token-cache hit. Cache status is unknown until usage arrives.

## Tests (no real inference)
claude: `tests/test-notice-transport.mjs` (node --test, 6) and `tests/test-notice-lifecycle.mjs` (bun, 6, mocks the SDK).
The lifecycle test needs `node_modules` resolvable from the skill root: `ln -sfn ~/claude-shim/node_modules <skill>/node_modules`.
If it isn't there, bun loads the REAL SDK and fails with "Not logged in".
codex: `tests/test-reasoning.py` (33, fake app-server) covers start/resume/replacement/large-context notices.

## Codex: why a session was replaced (Oct 3)
A Codex thread fixes `baseInstructions` + `dynamicTools` at creation, so any change in system prompt or
tool list (names, in order) forces a NEW thread and a full-history replay. Expensive: Oct 3 19:36 one swap
re-fed 365 blocks / ~930K chars. The state file now keeps `sys` and `toolNames`; on change `fpDiff()`
puts the concrete cause in the red line and appends a record to `~/codex-shim/fp-changes/changes.jsonl`
(first differing prompt line old/new, tools added/removed). Full old/new prompts go to `<stamp>.{old,new}.txt`.
Sessions created before this change have no stored data and say "старая сессия без данных".
Monitor: `tail ~/codex-shim/fp-changes/changes.jsonl`.

## Text mode for channels without a tool-activity label (Oct 4)

Telegram, Slack, WhatsApp, email, Discord, phone and a2a turns deliver only the assistant text, so the red failed-tool label never reaches the user. `notice-transport.js` reads the turn's channel from the latest user block — the `interface:` line of Vellum's per-turn `<turn_context>` (fallback: `channel:` in `<channel_capabilities>`); neither is stored in the DB or the system prompt. For interfaces in `SHIM_NOTICE_TEXT_INTERFACES` (default `telegram,whatsapp,slack,email,discord,phone,a2a`; empty disables) every notice is emitted as one plain `⚠ [shim] …` content line before the answer instead of the `__shim_notice__` tool call. Web/native clients are unchanged.
