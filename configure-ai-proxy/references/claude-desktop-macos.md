# Claude Desktop на macOS: authenticated HTTPS upstream

## Причина отдельной настройки

В проверенной версии Desktop `egressProxyUrl` принимает HTTP/HTTPS URL, но отклоняет embedded credentials (`user:password@`). Интерактивного входа на proxy тоже нет. Это подтверждено [официальной документацией](https://claude.com/docs/third-party/claude-desktop/network-proxy) и схемой установленного приложения.

Поэтому при HTTPS upstream с Basic auth используется:

```text
Claude Desktop → http://127.0.0.1:19443 → GOST
               → TLS + proxy authentication → upstream:9443
               → CONNECT → HTTPS Anthropic / claude.ai
```

HTTP на loopback здесь ожидаем: TLS до конечного сайта проходит внутри CONNECT, а GOST дополнительно использует TLS до upstream. Это не отключение проверки сертификатов. Локальный listener не открывать на `0.0.0.0` или LAN.

Настройки Claude Code могут управлять движком Code/Cowork, но не заменяют сетевые настройки веб-интерфейса Desktop. Не добавлять `HTTPS_PROXY` в случайное поле `claude_desktop_config.json`: наличие JSON-файла не означает поддержку любого ключа.

## 1. Инвентаризация и backup

Проверить версию `/Applications/Claude.app/Contents/Info.plist`, живой процесс, занятость порта, существующие службы и настройки:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
~/Library/Application Support/Claude/config.json
~/Library/Application Support/Claude-3p/configLibrary/_meta.json
~/Library/Application Support/Claude-3p/configLibrary/<appliedId>.json
/Library/Managed Preferences/com.anthropic.claudefordesktop.plist
/Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist
```

В исходной версии локальный `configLibrary` под `Claude-3p` читался и для proxy-настройки обычного Desktop. Он **не переключил** пользователя на стороннего provider: добавлен только `egressProxyUrl`. Для другого выпуска заново проверить поддержку и не переносить этот путь без проверки.

Managed policy может перекрыть локальные app-behavior keys группой. Не обходить её редактированием пользовательского файла; выявить активный источник и сообщить конфликт.

Если `_meta.json` уже существует, прочитать `appliedId`, `hybridPointer` и активный профиль. Не заменять всю библиотеку и не терять выбранный provider/bootstrap. Если `hybridPointer` делает saved profile неактивным, разобраться в поддерживаемом пути настройки; не удалять его по предположению.

Если библиотека отсутствует, создать новый UUID (`uuid.uuid4()`), файл с одним proxy-полем и метаданные выбора. Резервировать существующие изменяемые файлы; полезно сохранить также текущие `config.json` и `claude_desktop_config.json` перед restart. Они могут содержать секреты — backup `0700`, файлы `0600`.

## 2. Получить GOST

В исходном случае использован официальный **go-gost/gost v3.3.0**, macOS arm64:

```text
https://github.com/go-gost/gost/releases/download/v3.3.0/gost_3.3.0_darwin_arm64.tar.gz
SHA-256 f170226106844b50ab3435147f35d4300da773efca256b50cb2f8c7d3a151101
```

Это checksum конкретного архива, не любого релиза. Для другого CPU/выпуска получить официальный asset и проверить его digest/checksums. В исходном случае digest получен из GitHub release API:

```text
https://api.github.com/repos/go-gost/gost/releases/latest
```

Download в временный каталог → SHA-256 → безопасное извлечение нужного regular file `gost` → установка под выбранным именем `~/.local/bin/gost-claude`, права `0755` → `gost-claude -V`. Не делать pipe download → shell, не заменять существующий бинарник без diff/backup. Можно использовать подходящую уже установленную версию после проверки схемы.

GOST config-схемы находятся также в репозитории `go-gost/x`, а не обязательно в `go-gost/gost/config`. Некоторые угаданные документационные URLs оказались `404`; это не означает отсутствие TLS или auth.

## 3. Конфиг посредника

Новый файл `~/.config/claude-desktop-proxy/gost.json`, права `0600`:

```json
{
  "services": [{
    "name": "claude-desktop",
    "addr": "127.0.0.1:19443",
    "handler": {"type": "http", "chain": "upstream"},
    "listener": {"type": "tcp"}
  }],
  "chains": [{
    "name": "upstream",
    "hops": [{
      "name": "authenticated-proxy",
      "nodes": [{
        "name": "vpn",
        "addr": "PROXY_HOST:9443",
        "connector": {
          "type": "http",
          "auth": {"username": "PROXY_USER", "password": "PASSWORD"}
        },
        "dialer": {
          "type": "tls",
          "tls": {"serverName": "PROXY_HOST", "secure": true}
        }
      }]
    }]
  }],
  "log": {"level": "warn"}
}
```

В `connector.auth` пароль — обычная JSON-строка с корректным JSON escaping, **не** URL-encoded userinfo. В `dialer.tls.serverName` нужен hostname сертификата, не URL с портом. `secure: true` обязателен для проверки upstream TLS. `warn` уменьшает объём логов; если включать debug, убрать его после диагностики и проверить, что секреты не попали в журналы.

## 4. LaunchAgent

Файл `~/Library/LaunchAgents/net.anatolix.claude-proxy.plist`. Label — имя исходного случая; на другой машине можно выбрать своё, последовательно заменив в командах. `HOME_ABS` заменить абсолютным каталогом пользователя. LaunchAgent не раскрывает `~`/`$HOME` в строках аргументов.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.anatolix.claude-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>HOME_ABS/.local/bin/gost-claude</string>
    <string>-C</string>
    <string>HOME_ABS/.config/claude-desktop-proxy/gost.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>
  <string>HOME_ABS/Library/Logs/claude-desktop-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_ABS/Library/Logs/claude-desktop-proxy.log</string>
</dict>
</plist>
```

Пароля в plist и аргументах нет. Создать каталог логов при необходимости. Запускать от пользователя, не root; UID получить через `id -u`, не копировать `501`.

```bash
plutil -lint "$HOME/Library/LaunchAgents/net.anatolix.claude-proxy.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/net.anatolix.claude-proxy.plist"
lsof -nP -iTCP:19443 -sTCP:LISTEN
```

Не bootstrap повторно уже зарегистрированную службу. Проверить `launchctl print`; при изменении plist выполнить корректный bootout/bootstrap. Вывод `launchctl print` может содержать унаследованные env, поэтому для отчёта выбирать только state, pid, program и exit status.

**Гонка запуска:** bootstrap завершается раньше bind порта. В исходном случае первый curl получил connection refused, хотя служба уже показывала `running`; следующий запрос прошёл. Дождаться listener с ограниченным ожиданием, например до 10 секунд, проверяя состояние и журнал. Не менять пароль или порт из-за одной попытки до bind.

## 5. Проверить посредник до переключения Desktop

```bash
curl --silent --show-error --connect-timeout 15 --max-time 30 \
  --proxy 'http://127.0.0.1:19443' --noproxy '' \
  --header 'anthropic-version: 2023-06-01' \
  --write-out '\nHTTP=%{http_code} CONNECT=%{http_connect} TLS=%{ssl_verify_result}\n' \
  'https://api.anthropic.com/v1/models'
```

Ожидаемый результат без ключа: CONNECT `200`, конечный HTTP `401` с `x-api-key header is required`, проверка TLS `0`.

Здесь curl подключается к **HTTP loopback**, поэтому `proxy_ssl_verify_result` curl не проверяет удалённый HTTPS upstream. Эту часть выполняет GOST (`secure: true`). Не выдавать curl proxy TLS `0` за доказательство GOST-настройки.

Если upstream недоступен или auth отклонён, сначала исправить посредник; не переводить приложение на сломанный listener.

## 6. Включить маршрут Desktop

Для **новой** библиотеки:

`~/Library/Application Support/Claude-3p/configLibrary/<NEW_UUID>.json`:

```json
{"egressProxyUrl": "http://127.0.0.1:19443"}
```

`~/Library/Application Support/Claude-3p/configLibrary/_meta.json`:

```json
{"appliedId": "NEW_UUID"}
```

Для существующего профиля объединить только нужное поле после проверки active source. `egressProxyPacUrl`, если задан, имеет приоритет; конфликт разрешать явно, с backup и diff. Не держать пароль в URL Desktop: схема его отвергает.

Предпочитать документированный UI/конфиг. Если путь или schema в новой версии неясны, допустимо прочитать локальные bundled schema/config loader; не патчить `app.asar`. В исходном случае такое чтение подтвердило `configLibrary`, `appliedId` и ограничение credentials.

## 7. Перезапуск и подтверждение

Перед рестартом сохранить размер/позицию текущих `main.log` и `claude.ai-web.log`. Полностью завершить и заново открыть Claude поддерживаемым способом. Убедиться, что старый основной процесс завершён; окно, закрытое крестиком, не всегда завершает приложение. Не force-kill активные задачи без необходимости и разрешения.

Использовать доступный разрешённый инструмент UI управления; соблюдать его ограничения. При недоступности UI не обходить запрет другим методом снятия экрана. В исходном случае restart выполнен системным способом, но поздняя попытка прочитать UI через Computer Use закончилась ошибкой запуска сервиса; окончательная проверка опиралась на логи и TCP.

Журналы:

```text
~/Library/Logs/Claude/main.log
~/Library/Logs/Claude/claude.ai-web.log
~/Library/Logs/claude-desktop-proxy.log
```

Найти после нового старта:

```text
[egress-proxy] pinned to fixed proxy at 127.0.0.1:19443; OS proxy settings ignored
[CCD] CLI spawns use the pinned egress proxy http://127.0.0.1:19443
Loaded https://claude.ai
```

Подтвердить через `lsof -nP -iTCP:19443` реальные ESTABLISHED-соединения процесса Claude к localhost listener. Не делать вывод только по записи конфига или `launchctl state=running`.

В исходном случае после pinning ещё появился ранний `bootPreconnect … (direct)`. При этом живые соединения Claude шли в GOST, сайт загрузился и новые region errors прекратились. Одна ранняя строка не перевешивает более поздние данные; механизм/момент preconnect не был окончательно установлен.

При старте был один HTTP load failure и Turnstile; затем `Main view load recovered after 1 failed attempt(s)`. Дать приложению завершить штатное восстановление. Если CAPTCHA действительно требует человека — передать этот шаг пользователю, не утверждать, что решена автоматически.

Завершить проверкой отсутствия **новых** region/auth/proxy ошибок после activation marker. Отдельно назвать, проверялось ли сообщение модели. В исходном случае сообщение не отправлялось.

## 8. Откат

1. Сначала вернуть прежний профиль/`egressProxyUrl` и перезапустить Desktop, чтобы не оставить его указывающим на остановленный proxy.
2. Выгрузить только созданную службу:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/net.anatolix.claude-proxy.plist"
```

3. По манифесту убрать или переместить в rollback-каталог только созданные файлы. Не удалять всю `Claude-3p`: после запуска там могли появиться пользовательские настройки.
4. Не восстанавливать старый `config.json` с токенами без причины: для отмены нашего маршрута достаточно proxy-профиля. Backup этого файла был страховочным snapshot.
5. Проверить прежний маршрут и сохранить backup до подтверждения результата.

Источники: [Network proxy](https://claude.com/docs/third-party/claude-desktop/network-proxy), [Configuration](https://claude.com/docs/third-party/claude-desktop/configuration), [Desktop](https://code.claude.com/docs/en/desktop), [GOST releases](https://github.com/go-gost/gost/releases).
