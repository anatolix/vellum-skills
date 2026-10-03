# Codex: окружение, приложение и транспорт

## Определить установку

В исходной среде Codex размещался в **ChatGPT.app 26.930.21537**. Бинарник:

```text
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
```

Версия: `codex-cli 0.159.0-alpha.12.1`. Не предполагать, что этот путь/выпуск есть на другой машине или что обязательно есть `Codex.app`.

Проверить binary/version, активный `$CODEX_HOME` (обычно `~/.codex`), способ запуска и тип авторизации: ChatGPT subscription, API key или сторонний provider. Сеть оболочки и модельного движка может различаться.

Официальные источники: [Configuration reference](https://developers.openai.com/codex/config-reference), [Advanced configuration](https://developers.openai.com/codex/config-advanced), [App settings](https://developers.openai.com/codex/app/settings).

## Найденная локальная схема `.env`

В `$CODEX_HOME/.env`:

```dotenv
PROXY_URL="https://codex:PASSWORD@PROXY_HOST:9443"
HTTPS_PROXY="${PROXY_URL}"
HTTP_PROXY="${PROXY_URL}"
NO_PROXY="localhost,127.0.0.1,::1"
```

`codex` и `claude` — разные proxy users. Один host/port не гарантирует взаимозаменяемость учётных записей или одинаковый egress на сервере.

**Подтверждено:** файл существует; в shell-инструментах текущего Codex видны раскрытые proxy-переменные; backup-манифест сообщает о создании `.env` при предыдущей настройке. Это не универсальная гарантия поведения всех выпусков/GUI-хостов.

### Повторение

1. Определить активный `CODEX_HOME`, прочитать нужные поля `.env` без раскрытия секретов.
2. Проверить поддержку загрузки `.env` текущим клиентом. Прочитанные официальные страницы не установили универсального контракта автозагрузки для каждого GUI-хоста. Если поведение отличается, не выдумывать TOML-ключ `proxy`.
3. Показать diff, сохранить backup, объединить переменные; назначить `0600`.
4. Перезапустить соответствующий хост/движок. Для VS Code — Reload Window, при необходимости полный перезапуск.
5. Проверить новое окружение: схема, host, port, наличие userinfo; `${PROXY_URL}` должна быть раскрыта. Само значение пароля не выводить.
6. Проверить `https://api.openai.com/v1/models` без API-ключа, затем настоящую сессию нужного типа авторизации. ChatGPT-backed Codex использует и другие endpoints.

`PROXY_URL` — вспомогательное имя, не стандартная переменная клиента. Если dotenv-loader не раскрывает `${...}`, записать полные URL в `HTTPS_PROXY` и `HTTP_PROXY`. Специальные символы userinfo URL-encode; учесть dotenv-экранирование кавычек, `$` и обратных слешей.

### Если `.env` не загружается

Для CLI передать переменные **до запуска самого `codex`** из авторизованного источника секрета. Проверить приоритет существующего окружения: dotenv-loader может не заменять заданное ранее значение.

Dock/Launch Services могут не читать shell-профиль. Использовать механизм, поддерживаемый данным GUI-хостом, с проверкой фактического эффекта. Не делать глобальный `launchctl setenv` первым решением: он затрагивает другие GUI-процессы и сам по себе не переживает reboot.

Не `source` неизвестный `.env` — это исполнение кода. Не помещать пароль в argv launcher/plist. Если нужен wrapper, пусть читает защищённый файл; его область действия должна быть явной.

## Что не является настройкой upstream-прокси

- `[shell_environment_policy]` задаёт окружение **команд, запускаемых Codex**. Proxy только там не доказывает маршрут самого модельного клиента.
- `features.network_proxy` и network permission profiles относятся к сети sandboxed-команд и ограничениям destinations. Не включать их по аналогии с upstream-прокси и не отключать sandbox ради сети.
- `model_providers.<id>.base_url`, `openai_base_url`, `chatgpt_base_url` — API/auth endpoints. В них нельзя подставлять адрес обычного CONNECT-прокси.

## HTTP вместо WebSocket: условный workaround

В текущем **пользовательском** `config.toml` найдено:

```toml
model_provider = "chatgpt-http"

[model_providers.chatgpt-http]
name = "ChatGPT HTTP"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Reference подтверждает смысл `supports_websockets` как поддержки транспорта Responses API WebSocket. `wire_api = "responses"` — протокол API, он не означает обязательный WebSocket.

**Не применять блок автоматически.** В видимой дискуссии не воспроизводилась ошибка WebSocket, и необходимость такого изменения не доказана. Найден backup `config.toml.before-chatgpt-http-…bak`; мотив изменения вне показанных шагов неизвестен.

Подобный fallback допустим, когда диагностирована ошибка WebSocket/streaming при рабочем HTTPS и одновременно:

- используется ChatGPT login, не API key/Azure/иной provider;
- версия поддерживает поля и endpoint;
- сохранены прежний `model_provider` и backup TOML;
- показан diff, сохранены другие model/auth/provider-настройки.

Этот `base_url` — наблюдённый endpoint установки, не универсальный публичный API-контракт. Не копировать ChatGPT profile для API-key режима. Сначала различить CONNECT, TLS, upgrade, долгий stream и auth; затем менять транспорт. После fallback проверить настоящее потоковое сообщение.

## Откат

Восстановить изменённый `.env`; если его раньше не было, убрать только созданный файл с сохранением последующих пользовательских правок. При смене provider восстановить root `model_provider` и созданный блок либо полный backup, если новых правок не было. Перезапустить клиент и проверить маршрут. Не читать/выводить `auth.json` или Keychain для такой проверки.
