---
name: "Chat diagnostics → Markdown"
description: "Выгружает полную диагностику чата Vellum в один .md: все сообщения со всеми блоками (текст, thinking, tool_use/параметры, tool_result, системные вставки), у каждого сообщения сверху Vellum ID, client_message_id, роль, время — и для каждого ID статус в CLI-сессиях (Claude/Codex shim): session/thread ID, наличие в per-session SQLite-карте source-id, найденный CLI uuid или явное предупреждение, что его нет."
metadata:
  vellum:
    activation-hints:
      - пользователь просит диагностику чата в md, дамп чата с ID сообщений, проверку связки vellum id / cli id
    avoid-when:
      - нужен красивый человекочитаемый экспорт для публикации — для этого chat-to-markdown-export
    category: development
---

# Chat Diagnostics → Markdown

Диагностический дамп чата. Отличается от `chat-to-markdown-export`: цель — не читаемость, а полнота и трассировка ID (Vellum row id ↔ CLI session/thread ↔ per-session source-id map обоих шимов).

## Запуск

```
python3 {baseDir}/scripts/diag-chat.py <conversation-id | префикс | точное название> [-o файл.md]
```

Без аргумента берёт текущий чат из `__CONVERSATION_ID`. Если название совпадает у нескольких чатов — берёт самый свежий и пишет предупреждение со списком кандидатов (тогда лучше передать id/префикс явно). Вывод по умолчанию: `scratch/diag-<id8>.md`.

## Что внутри выходного файла

1. **Шапка**: conversation id, название, даты, профиль инференса, статистика по ролям, события компакции (`conversation_compaction_events`).
2. **Связка с шимами**: скрипт сканирует `~/claude-shim/sessions/*.json` и `~/codex-shim/sessions/*.json`, ищет `key == conversation_id`. Для найденных: sessionId (Claude) / threadId (Codex), модель, served, путь к `*.ids.sqlite`, число записей в карте, путь к транскрипту CLI (`~/.claude/projects/-home-vellum-claude-shim/<sessionId>.jsonl`, rollout `~/.codex/sessions/**/rollout-*<threadId>*.jsonl`).
3. **Сообщения** — одна строка таблицы на одну строку `messages`, ровно три колонки:
   - `vellum_id` — полный ID без обрезки; пустой ID отмечается явным предупреждением.
   - `cli_id / tool_id` — полные Claude/Codex CLI ID из `cli_ids`; для вызовов и результатов также показывается `tool_id`, который считается полноценной CLI-связкой. Старый transcript fallback допускается только с подписью `по тексту`. Если нет ни одного пригодного ID — явное предупреждение.
   - `Сообщение и атрибуты` — номер, роль, время, `finalized`, `client_message_id`, все поля строки `messages` и все content-блоки целиком.
4. Длинное содержимое сворачивается через `<details>`, но не обрезается и не теряется.

## Источники данных

- `data/db/assistant.db` (read-only, `mode=ro`): `messages`, `conversations`, `conversation_compaction_events`, `conversation_keys`. Колонка `content` — JSON-массив блоков.
- Shim state: `~/claude-shim/sessions/<sha1(key)>.json` → `key, sessionId, model, served`; рядом `<sha1>.ids.sqlite` (таблица `blocks`: source_id, hash, kind; с патча 9 — таблица `cli_ids`: vellum_id ↔ cli_id, kind reply/tool_use/tool_result/user, fed — это основной источник пар, транскрипт только fallback с пометкой «по тексту»). Аналогично `~/codex-shim/sessions/` → `threadId`. SQLite-карты открываются через immutable-копию во временный файл, чтобы не ловить WAL-локи живого шима.
- Транскрипты: Claude — `~/.claude/projects/-home-vellum-claude-shim/<sessionId>.jsonl` (поля `uuid`, `message.content`); Codex — rollout-jsonl по threadId.

## Границы

- Ничего не пишет в БД и не трогает живые шимы — только чтение.
- Синтетические сообщения Vellum (`<system_notice>`, `__PLACEHOLDER__`, `<context_summary>` после компакции) по определению не имеют пары в CLI-транскрипте — скрипт помечает их отдельно (`synthetic`), это не ошибка дампа.
- Секреты не фильтруются (диагностический артефакт для внутреннего пользования). Не коммитить вывод в публичные репозитории.
