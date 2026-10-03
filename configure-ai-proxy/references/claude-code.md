# Claude Code: терминал и VS Code

## Обнаружение

Проверить `command -v claude`, `claude --version`, `CLAUDE_CONFIG_DIR`, активный профиль VS Code и место исполнения расширения (локальное, SSH, WSL, container). В удалённом случае локальный файл может не влиять на процесс.

Обычные пути macOS:

- `~/.claude/settings.json` — пользовательские настройки агента.
- `.claude/settings.json`, `.claude/settings.local.json` — проектные настройки; отдельно проверить managed policy.
- `~/Library/Application Support/Code/User/settings.json`; дополнительные профили — `User/profiles`.
- `~/.vscode/extensions/anthropic.claude-code-*/package.json` — схема установленных настроек расширения.

Не путать `~/.claude.json` с `~/.claude/settings.json`. В проверенном `package.json` есть `claudeCode.environmentVariables`, и его описание рекомендует общий Claude `settings.json`.

## Общий конфиг Claude Code

Объединить этот фрагмент с существующим `env`, сохранив permissions, model, effortLevel, hooks и остальные поля:

```json
{
  "env": {
    "HTTPS_PROXY": "https://USERNAME:PASSWORD@PROXY_HOST:9443",
    "HTTP_PROXY": "https://USERNAME:PASSWORD@PROXY_HOST:9443",
    "NO_PROXY": "localhost,127.0.0.1,::1"
  }
}
```

Обе переменные указывают на **HTTPS** upstream. Не менять схему на `http` из-за имени `HTTP_PROXY`. В исходной настройке proxy user был `claude`; Codex использовал другого пользователя. Нельзя без проверки копировать окружение диагностического агента.

Percent-encode специальные символы userinfo, а не весь URL:

```python
from urllib.parse import quote
proxy_url = f"https://{quote(username, safe='')}:{quote(password, safe='')}@{host}:{port}"
```

Сохранить конфиг с правами `0600`, полностью завершить старую CLI-сессию и открыть новую. Повторный запуск задаёт однозначную границу проверки даже там, где часть настроек перечитывается динамически.

### Конфликты

Проверить оба регистра `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, а также managed/project scope. Документация Claude Code указывает порядок первого непустого: `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`. Верхний регистр не всегда выигрывает.

`NO_PROXY=*` отключает прокси. Домен Anthropic в bypass тоже обойдёт маршрут. Корпоративный bypass-список не очищать вслепую: сохранить нужные внутренние адреса, показать изменение.

## Только расширение VS Code

```json
{
  "claudeCode.environmentVariables": [
    {"name": "HTTPS_PROXY", "value": "https://USERNAME:PASSWORD@PROXY_HOST:9443"},
    {"name": "HTTP_PROXY", "value": "https://USERNAME:PASSWORD@PROXY_HOST:9443"},
    {"name": "NO_PROXY", "value": "localhost,127.0.0.1,::1"}
  ]
}
```

Существующий массив объединять по `name`, сохраняя другие env и устраняя конфликтующие дубликаты. Общий конфиг и env расширения, если заданы оба, должны быть согласованы. Дублирование допустимо при запросе двух клиентов, но требует обновления обоих при смене пароля.

VS Code допускает JSONC: комментарии и trailing commas. Не прогонять такой файл через обычный `json.loads`/`json.dumps`. Использовать JSONC-совместимое редактирование или точечную вставку.

Для применения — **Developer: Reload Window**; убедиться в замене старого дочернего процесса. В исходном случае пользователь подтвердил работу расширения.

## Что показал пример CoreInfra

PDF описывал Claude Code: установка `@anthropic-ai/claude-code`, `~/.claude/settings.json`, `claude auth login`, запуск `claude`. Пункт «Claude Desktop» в боковом меню не меняет предмет инструкции.

| Поле | Назначение | Переносить на обычный прокси? |
|---|---|---|
| `HTTPS_PROXY` с user/password | Сетевой маршрут | Да |
| `ANTHROPIC_BASE_URL` | API endpoint хаба | Нет |
| `ANTHROPIC_CUSTOM_HEADERS` | Ключ хаба | Нет |
| `CLAUDE_ENV_FILE` → `no-proxy.sh` | Окружение shell-команд агента | Только при отдельной необходимости |
| `NO_PROXY` с доменом хаба | Обход для собственного API-хаба | Не копировать механически |

В PDF скрипт делал `unset HTTPS_PROXY NO_PROXY`. При нашей схеме это оставило бы `HTTP_PROXY`. Если нужно отделить сеть агента от его команд, учитывать все регистры proxy-переменных и нужные bypass. В исходном случае такой скрипт **не устанавливался**.

В JSON нет shell expansion. Для `CLAUDE_ENV_FILE` нужен настоящий абсолютный путь, а не `~` или `$HOME`.

## Проверка

1. Конфиг парсится, остальные ключи сохранены, backup совпадает с исходным файлом.
2. Запрос с URL из сохранённого конфига достигает API.
3. Новая сессия использует ожидаемый proxy: `/status` (если показывает Proxy), debug-лог и соединения. Скрывать пароль при выводе.
4. Сообщение модели проверить в рамках разрешённого действия либо предложить пользователю. Unauthenticated `401` не является тестом генерации.

Источники: [Settings](https://code.claude.com/docs/en/settings), [Network configuration](https://code.claude.com/docs/en/network-config).
