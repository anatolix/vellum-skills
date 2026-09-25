---
name: "Claude Code as a Vellum chat model — install, OAuth, tool-capable shim"
description: "End-to-end: install Claude Code CLI on a self-hosted Vellum VM, obtain a Claude OAuth token via the loopback callback trick, run a local OpenAI-compatible shim (Bun + Claude Agent SDK) that supports OpenAI function calling via a prompt contract, register it as a Vellum provider, and verify tools work end-to-end. Verified Ubuntu 24.04, Vellum 0.12.x, Claude Code 2.1.x, Agent SDK 0.3.x."
metadata:
  vellum:
    emoji: 🔌
    activation-hints:
      - user wants Claude Code / Claude subscription as the chat model in Vellum
      - Claude Code profile in Vellum answers but has no tools (no bash, file, UI)
      - needs an OpenAI-compatible backend that proxies to Claude Code
      - wants to add claude-code as a Vellum inference provider
      - shim returns text instead of tool_calls
    avoid-when:
      - user has an Anthropic API key and can use OpenRouter/Anthropic directly (native tools, no shim needed)
      - user only wants to delegate coding tasks to Claude Code (use the acp skill)
    category: development
---

# Claude Code as a Vellum chat model

Make Claude Opus/Sonnet available as Vellum chat profiles **on a Claude subscription** (no API key), with working tools.

Architecture:

```
Vellum daemon ──OpenAI chat/completions──▶ claude-shim (Bun, 127.0.0.1:8317)
   ▲  executes tools, trust rules            │  @anthropic-ai/claude-agent-sdk query()
   └──── tool_calls / content ◀──────────────┘  CLAUDE_CODE_OAUTH_TOKEN → Claude Code
```

Key insight: Claude Code's SDK does not accept OpenAI-style tool definitions, and Vellum
must remain the executor (trust rules, guardian approval). The shim renders Vellum's
`tools` into the prompt as a text contract, parses `TOOL_CALL:` lines from the model
output, and returns real OpenAI `tool_calls` deltas. Claude Code's own tools
(Bash/Read/...) stay disabled so the model cannot bypass Vellum.

## Prerequisites

- Self-hosted Vellum (user `vellum`, sudo), bun on PATH
- Claude subscription (Pro/Max) — the token comes from OAuth login, not an API key
- Node.js 22+ **only** if you also want ACP (`claude-agent-acp` is a node script)

## Procedure

### 1. Install Claude Code CLI

```bash
curl -fsSL https://claude.ai/install.sh | bash        # → ~/.local/bin/claude
~/.local/bin/claude --version                          # 2.1.x
```

(Optional, for ACP too:)
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
bun add -g @agentclientprotocol/claude-agent-acp
```

### 2. Obtain the OAuth token (headless VM, phone in hand)

The VM has no browser; the OAuth redirect goes to `http://localhost:<port>/callback`
**on the VM**. Trick: user opens the login URL on their phone, the final redirect
fails to load (404 / connection refused — expected), user pastes that full redirect URL
into chat, the assistant curls it into the VM loopback listener.

Option A — Vellum's inline "Connect Claude Code" card (acp skill) does this flow and
stores the token as credential `acp/claude_oauth_token`.

Option B — manual:
```bash
~/.local/bin/claude setup-token      # prints URL; paste redirect URL back when asked
# then store the sk-ant-oat… token via secure prompt (never inline):
assistant credentials prompt --service acp --field claude_oauth_token
```

Verify: `assistant credentials list | grep acp` shows `acp:claude_oauth_token`.

### 3. Create the shim project

```bash
mkdir -p ~/claude-shim && cd ~/claude-shim
bun init -y
bun add @anthropic-ai/claude-agent-sdk
cp {baseDir}/scripts/server.js ~/claude-shim/server.js
```

`server.js` (full source in `{baseDir}/scripts/server.js`):
- `GET /v1/models` → `claude-opus`, `claude-sonnet`
- `POST /v1/chat/completions` (SSE), model id `claude-X` → SDK model `X`
- `messagesToPrompt(messages, tools)`: system → `<system>`, user → `Human:`,
  assistant → `Assistant:` (+ `TOOL_CALL:` lines for historical tool_calls),
  role `tool` → `<tool_result name="...">…</tool_result>`; if `tools` present,
  prepend `<tools>[defs]</tools>` + contract text
- Contract: model emits ONLY `TOOL_CALL: {"name": "...", "arguments": {...}}` lines to call
- Output with tools is **buffered** (no token streaming) so TOOL_CALL lines can be detected;
  parsed calls → `delta.tool_calls` + `finish_reason: "tool_calls"`, else content + `stop`
- SDK options: `tools: [], allowedTools: [], permissionMode: "bypassPermissions",
  settingSources: [], maxTurns: 1`, `env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN }`
- `Bun.serve({ idleTimeout: 255 })` — default 10s kills slow SDK spawns

### 4. Wrapper `run.sh` (pulls token from Vellum vault at start, never on disk)

```bash
#!/bin/bash
export PATH="/home/vellum/.bun/bin:/home/vellum/.local/bin:/usr/local/bin:/usr/bin:/bin"
export VELLUM_WORKSPACE_DIR=/home/vellum/.local/share/vellum/assistants/<name>/.vellum/workspace
export VELLUM_DATA_DIR=$VELLUM_WORKSPACE_DIR/data
export VELLUM_CLOUD=local VELLUM_ENVIRONMENT=local
export CLAUDE_CODE_OAUTH_TOKEN="$(assistant credentials reveal --service acp --field claude_oauth_token)"
exec bun run /home/vellum/claude-shim/server.js
```
`chmod +x run.sh`

### 5. systemd user unit `~/.config/systemd/user/claude-shim.service`

```ini
[Unit]
Description=Claude Code OpenAI-compatible shim
After=vellum-<name>.service

[Service]
ExecStart=/home/vellum/claude-shim/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-shim.service
journalctl --user -u claude-shim -n 5 --no-pager   # "listening on 127.0.0.1:8317 (tools: prompt-contract)"
```

### 6. Register provider + profiles in Vellum

```bash
assistant inference providers create claude-code \
  --provider openai-compatible --auth none \
  --base-url http://127.0.0.1:8317/v1 \
  --model claude-opus --model claude-sonnet

assistant inference profiles create claude-code-opus \
  --provider openai-compatible --connection claude-code \
  --model claude-opus --label "Claude Code (Opus)" --allow-unlisted

assistant inference profiles create claude-code-sonnet \
  --provider openai-compatible --connection claude-code \
  --model claude-sonnet --label "Claude Code (Sonnet)" --allow-unlisted
```

Optional default: `assistant inference profiles active claude-code-opus`
(affects **new** sessions only).

## Verification

Three curl tests against the shim (`{baseDir}/scripts/test-shim.sh` runs all three):

1. No tools → `content: "Париж."`, `finish_reason: stop`
2. With `tools=[get_weather]` + "используй инструмент" → `delta.tool_calls[0].function.name == get_weather`, `finish_reason: tool_calls`
3. History with `assistant.tool_calls` + `role: tool` result → final text, `stop`

End-to-end: open a **new** Vellum chat on profile *Claude Code (Opus)*, ask for
`uname -a` — bash must run.

## Gotchas

- **No tools in Vellum = shim problem, not Vellum config.** There is no per-profile
  "enable tools" switch. If the shim passes `tools: []` to the SDK and ignores
  `body.tools`, every session on that profile is text-only.
- `CLAUDE_CODE_OAUTH_TOKEN` must be passed via `options.env`; the SDK child does not
  inherit implicitly. `token_len=0` in the log → run.sh could not reveal the credential
  (usually missing `VELLUM_WORKSPACE_DIR` in the systemd env).
- With tools present the reply is not streamed token-by-token — whole answer at once.
  Vellum system prompts are large; first reply on Opus takes 15–30 s.
- Prompt-contract calling is not schema-enforced. Opus/Sonnet follow it reliably; a
  malformed `TOOL_CALL` line is left as text (visible in chat) rather than crashing.
- Keep `tools: [], allowedTools: []` in the SDK options. Enabling Claude Code's native
  tools would let the model touch the filesystem outside Vellum's trust rules.
- Bun `idleTimeout` default (10 s) → Vellum shows "Could not connect to the AI provider".
- Rollback: `cp server.js.bak-pre-tools server.js && systemctl --user restart claude-shim`.

See `{baseDir}/references/failure-modes.md` for more.
