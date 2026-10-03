# Факты исходного случая и источники

Дата: **2026-10-03**, macOS arm64, пользовательская временная зона **Asia/Baghdad**. Это эксплуатационный разбор наблюдений и решений; он не приписывает непроверенные причины ошибкам.

## Конечная конфигурация

| Компонент | Файл/механизм | Статус доказательства |
|---|---|---|
| Proxy upstream | `https://vpn.anatolix.net:9443`, разные users `claude` и `codex` | Пользователь предоставил Claude credentials; Codex credentials обнаружены в уже настроенном окружении. Пароли исключены |
| Claude Code CLI | `~/.claude/settings.json`: HTTPS_PROXY, HTTP_PROXY, NO_PROXY | Создано в дискуссии, JSON и запрос из сохранённых env проверены |
| Claude VS Code | `~/Library/Application Support/Code/User/settings.json`: `claudeCode.environmentVariables` | Создано в дискуссии; пользователь подтвердил работу |
| Claude Desktop | `Claude-3p/configLibrary/<id>.json` + `_meta.json` | Создано, app startup подтвердил pinning, живые соединения подтверждены |
| GOST | `~/.local/bin/gost-claude`, `~/.config/claude-desktop-proxy/gost.json` | Официальный v3.3.0, SHA-256 проверен, localhost listener работает |
| Autostart | `~/Library/LaunchAgents/net.anatolix.claude-proxy.plist` | plist lint и running LaunchAgent проверены; reboot/login не воспроизводился |
| Codex | `~/.codex/.env` | Найден при создании навыка; текущий процесс имеет раскрытые proxy env |
| Codex transport | `~/.codex/config.toml`, provider `chatgpt-http` | Найден при создании навыка; сравнительный HTTP/WebSocket тест не выполнялся |

Порт localhost: `19443`. UUID созданного Desktop-профиля: `146cd5b9-2d06-4a4b-91e3-a822f19c667e`. На другой машине генерировать новый UUID и выбирать свободный порт.

Версии на момент проверки:

- Claude Code CLI `2.1.92`.
- Claude Code extension `2.1.288-darwin-arm64`.
- Claude Desktop `2.19675.0`.
- GOST `3.3.0` (darwin/arm64).
- Хост Codex/ChatGPT `26.930.21537`.
- Встроенный Codex CLI `0.159.0-alpha.12.1`.

## Последовательность и результаты

1. Тест Anthropic API через HTTPS-прокси в sandbox не разрешил DNS proxy. Повтор с разрешённым сетевым доступом: CONNECT `200`, HTTP `401`, `x-api-key header is required`, оба TLS verification `0`.
2. Найдены CLI, VS Code extension и Desktop. Пользователь уточнил, что первоначально под «локально Claude» имел в виду macOS-приложение.
3. После diff и backup настроен VS Code. Позже по явному запросу добавлен общий Claude Code env. Пример CoreInfra изучен, его API gateway поля не копировались.
4. Пользователь подтвердил, что VS Code работает. Сообщение о «codex» с region error по уточнению относилось к Claude Desktop.
5. Desktop в 16:52:55 писал `proxy for https://claude.ai resolved … (direct)`. Затем журнал веб-интерфейса содержал `Claude isn't available in your region.`. Системный proxy не был настроен.
6. После разрешения Desktop-настройки показан diff четырёх новых конфигов и описана установка бинарника. Сохранены Desktop snapshots, установлен GOST с TLS verification и LaunchAgent.
7. Первый curl сразу после bootstrap получил connection refused; повтор после bind дал CONNECT `200`, конечный `401`, TLS `0`.
8. Desktop перезапущен. В 17:03:44 — `[egress-proxy] pinned to fixed proxy at 127.0.0.1:19443; OS proxy settings ignored`. В 17:03:50 — `[CCD] CLI spawns use the pinned egress proxy ...`.
9. В 17:03:54 — `Main view load recovered after 1 failed attempt(s)` и `Loaded https://claude.ai`. Последующие служебные запросы к claude.ai успешны; `lsof` показал ESTABLISHED соединения процесса Claude с localhost proxy.
10. На момент итоговой проверки region errors после activation marker: **0**. Сообщение модели не отправлялось; работа каждого инструмента Cowork и после reboot не проверялась.

## Backup на исходной машине

Пути нужны для восстановления этого случая, не для буквального копирования в новый deployment:

```text
~/Library/Application Support/Code/User/settings.json.backup-20261003-164207
~/.claude/settings.json.backup-20261003-165232
~/.config/claude-desktop-proxy/backup-20261003-170305/
  claude_desktop_config.json
  config.json
  new-files.json
~/.codex/backups/proxy-2026-10-03.wnjuCU/
~/.codex/config.toml.before-chatgpt-http-20261003T132337072825Z.bak
```

Codex backup `rollback.txt` говорит: до настройки `.env` отсутствовал; изменением было создание этого файла; `config.toml`, VS Code settings и bash profile были snapshots и тогда не изменялись. Это отдельное локальное свидетельство, а не действие, выполненное в показанных Claude-шагах.

## Чего не делали

- Не меняли системный proxy macOS.
- Не отключали TLS verification.
- Не патчили `app.asar` и не меняли бинарник Claude.
- Не подключали CoreInfra и не копировали его API key.
- Не меняли Anthropic API endpoint на адрес proxy.
- Не создавали `CLAUDE_ENV_FILE`/`no-proxy.sh`.
- Не доказывали обход всех региональных проверок: подтверждён конкретный рабочий маршрут и отсутствие свежей ошибки в проверенном окне времени.

## Источники

Прочитаны или проверены при выполнении задачи/создании навыка:

- [Claude Code network configuration](https://code.claude.com/docs/en/network-config)
- [Claude Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Desktop network proxy](https://claude.com/docs/third-party/claude-desktop/network-proxy)
- [Claude Desktop configuration](https://claude.com/docs/third-party/claude-desktop/configuration)
- Установленный `anthropic.claude-code-2.1.288-darwin-arm64/package.json`.
- Read-only schema и config loader из `/Applications/Claude.app/Contents/Resources/app.asar`.
- [Официальный GOST release](https://github.com/go-gost/gost/releases/tag/v3.3.0), [схемы GOST](https://github.com/go-gost/x/blob/master/config/config.go).
- [Codex configuration reference](https://developers.openai.com/codex/config-reference), [advanced configuration](https://developers.openai.com/codex/config-advanced), [app settings](https://developers.openai.com/codex/app/settings).
- Пользовательский PDF `CoreInfra AI Hub.pdf`: одна страница инструкции для Claude Code, JSON обрезан справа. HTML был только оболочкой страницы. Исходные документы и секреты в skill не включены.

Правило поддержки: при отличающихся версиях сначала сверять актуальную документацию и установленную schema; найденные в этой установке внутренние пути не объявлять вечным публичным API.
