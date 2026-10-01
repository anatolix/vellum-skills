---
name: "Claude Code as a Vellum chat model — install, OAuth, tool-capable shim"
description: "End-to-end: install Claude Code CLI on a self-hosted Vellum VM, obtain a Claude OAuth token via the loopback callback trick, run a local OpenAI-compatible shim (Bun + Claude Agent SDK) that keeps one Claude Code session per Vellum conversation (prompt cache hits ~97%), supports OpenAI function calling either natively (Vellum tools registered on the CLI as an in-process SDK MCP server, default) or via a text prompt contract, passes the Vellum system prompt natively, reports token usage; plus a stdio MCP bridge (vellum-mcp.ts) that exposes Vellum tools to any Claude Code process (used with RichardAtCT/claude-code-openai-wrapper). Register as a Vellum provider and verify end-to-end. Verified Ubuntu 24.04, Vellum 0.12.x, Claude Code 2.1.x, Agent SDK 0.3.x."
metadata:
  vellum:
    emoji: 🔌
    activation-hints:
      - user wants Claude Code / Claude subscription as the chat model in Vellum
      - Claude Code profile in Vellum answers but has no tools (no bash, file, UI)
      - needs an OpenAI-compatible backend that proxies to Claude Code
      - wants to add claude-code as a Vellum inference provider
      - shim returns text instead of tool_calls
      - Claude Code profile prints tool calls as JSON/text; shim log says init tools=0 mcp=[vellum:connected]
      - parallel tool calls from Claude Code arrive one per round trip
      - Claude Code profile is slow / cache_read=0 on every request; wants session continuation
      - wants Vellum tools (recall, web_search, telegram…) callable from inside Claude Code via MCP
    avoid-when:
      - user has an Anthropic API key and can use OpenRouter/Anthropic directly (native tools, no shim needed)
      - user only wants to delegate coding tasks to Claude Code (use the acp skill)
    category: development
---

# Claude Code as a Vellum chat model

Make Claude Opus/Sonnet available as Vellum chat profiles **on a Claude subscription** (no API key), with working tools.

Architecture (current, Sep 30):

```
Vellum daemon ──OpenAI chat/completions + prompt_cache_key──▶ claude-shim (Bun, 127.0.0.1:8317)
   ▲  executes tools, trust rules                              │  one long-lived `claude` process PER CHAT
   │                                                           │  (streaming-input query(), resume after idle)
   │                                                           │  request `tools` → in-process SDK MCP server
   └──── tool_calls / content / usage ◀────────────────────────┘  CLAUDE_CODE_OAUTH_TOKEN → Claude Code
```

Key ideas:

1. **Vellum stays the tool executor — but the model calls tools natively.**
   (`SHIM_TOOL_MODE=mcp`, default since Sep 30.) The shim turns the request's OpenAI
   `tools` into an in-process MCP server (`createSdkMcpServer` + `tool()` with zod shapes
   derived from the JSON schemas) and hands it to the CLI as `mcpServers: {vellum}`,
   `allowedTools: ["mcp__vellum__<name>", …]`. The model emits real `tool_use` blocks; the
   MCP handler **executes nothing** — it parks on a promise, the request layer forwards the
   batch to Vellum as OpenAI `tool_calls` (prefix stripped, real `toolu_…` ids), ends the
   HTTP response, and releases the per-chat lock. Vellum runs the tool (approvals, trust,
   UI cards all stay in Vellum) and sends the next request with `role: tool`; the shim
   resolves the parked handler by `tool_call_id` and *attaches* to the still-running CLI
   turn instead of feeding a new prompt. Claude Code's own tools stay disabled.
   `SHIM_TOOL_MODE=text` keeps the old contract: `tools` rendered into the system prompt,
   `TOOL_CALL:` lines parsed (multi-line scanner + salvage) — see references/ for its history.
2. **One CLI process per chat, keyed by `prompt_cache_key`** (= Vellum conversation id;
   needs the local Vellum patch that forwards it to openai-compatible providers, see
   step 7). The CLI transcript is the source of truth; Vellum's history is only *diffed*:
   every user/tool_result block whose sha1 the chat has not seen is fed, in order.
   Nothing is ever re-sent, there is no `/clear`, no reset. Result: on a live chat the
   Anthropic prompt cache hits ~97% (`cache_read` ≈ whole prompt, write = the delta).
3. **Park / resume.** A chat idle > `SHIM_IDLE_TTL_SEC` (3600) or evicted by the
   `SHIM_MAX_LIVE` (8) cap is *parked*: `{sessionId, sent hashes, model, sysHash}` saved to
   `sessions/<sha1(key)>.json`, process killed. Next request spawns with
   `resume: sessionId` and feeds only the tail. SIGTERM parks everything, so a shim
   restart keeps sessions. If resume fails → fresh process with the full history (no
   cache hit, nothing to do about it).
4. **System prompt goes native.** Vellum's `system` messages + the tool contract are
   passed at spawn as `systemPrompt: {type:"custom", prompt, snapshot:false}`, replacing
   Claude Code's own prompt. Vellum's system field is stable per chat (dynamic context
   is injected into the tail user message, not the system field), so this is safe; if it
   does change, the chat is parked and respawned with resume — transcript survives.
5. **One-shot requests bypass the chat pool.** A request whose history has no `assistant`
   or `tool` turn (first message of a conversation — which for `assistant inference send`,
   subagent scripts and batch pipelines is the *only* message) is served by a throwaway
   process, closed right after the answer, logged as `[oneshot <key>]`. Keyless requests
   are the same path, tagged `[nokey]`. Neither counts against `SHIM_MAX_LIVE`; they have
   their own OOM guard `SHIM_MAX_ONESHOT` (32, 0 = unlimited, ~220 MB per process).
   Cost for a real chat: its turn 2 finds no Chat for the key and spawns one with the
   full two-block history — one wasted cache write, then normal. Before this, every
   `inference send` created a "chat" whose process sat in a slot until the 1h TTL and
   batch pipelines starved real chats of slots.
6. **Thinking summaries stream to the UI.** Every spawn gets
   `thinking: {type:"adaptive", display:"summarized"}` — without `display:"summarized"`
   subscription thinking blocks are redacted (empty text, only `estimated_tokens`).
   `thinking_delta` events are forwarded as SSE `delta.reasoning_content`, which Vellum
   renders as the thinking block. `reasoning_effort` from the request maps to SDK
   `effort` (xhigh/max clamp to high); `"none"` disables thinking. Mid-chat effort change
   parks + respawns the process (same as system-prompt change).
5. **Compaction** on the Vellum side just shows up as one new unseen block (the summary)
   — fed as text, the CLI keeps its own full transcript.
6. **Keyless requests** (no `prompt_cache_key`, e.g. `assistant inference send`,
   subagents from CLI scripts) get a throwaway process (`runEphemeral`, 3 attempts).
7. **Usage** from the CLI result is emitted as a final SSE chunk (`prompt_tokens` =
   input+cache_read+cache_write, `prompt_tokens_details.cached_tokens`,
   `cache_write_tokens`) — Vellum shows it in the usage indicator / `assistant usage`.

A second, independent piece: **`vellum-mcp.ts`** — a stdio MCP server that exposes
Vellum's registered tools (via `ToolExecutor`, same path as `assistant tools run`) to
*any* Claude Code process. Used to give RichardAtCT/claude-code-openai-wrapper access to
Vellum tools (step 8). Not used by the shim itself (yet — next step is
`createSdkMcpServer` from the request `tools`, replacing the text contract).

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

### 1a. Claude CLI setup notes

- Binary lives in `~/.local/bin/claude`. systemd user units do not have it on PATH —
  `run.sh` exports PATH explicitly.
- `~/.claude/` is created on first run (`projects/`, `policy-limits.json`,
  `remote-settings.json`, `backups/`). No `settings.json` is needed for the shim.
- The shim passes `settingSources: []` to the SDK, so user/project settings and any
  `CLAUDE.md` under `~/.claude` are **ignored** — nothing leaks into Vellum prompts.
  Keep it that way.
- Health check: `claude doctor`. Auth check: `claude auth status` (JSON).
  With a setup-token it shows `loggedIn: false, authMethod: none` — expected: the token
  is not in `~/.claude`, it lives in the Vellum vault and reaches the SDK via
  `CLAUDE_CODE_OAUTH_TOKEN`.
- Optional: `export DISABLE_AUTOUPDATER=1` in `run.sh` to avoid surprise CLI upgrades
  under a running service; upgrade deliberately with `claude update`.

### 1b. OAuth tokens come in different lifetimes — pick the right one

All of them look the same (`sk-ant-oat01-…`, 108 chars). You cannot tell the lifetime
by looking at the token. What we observed:

| Source | Lifetime | Where it ends up | Refresh |
|---|---|---|---|
| Vellum inline "Connect Claude Code" card (ACP) | **~10 h** (issued Sep 25 evening, `401` at 05:47 next morning) | vault `acp/claude_oauth_token` | none — dies silently |
| `claude auth login` / `/login` in the TUI | short access token + refresh token (*not verified here — we never used this path*) | `~/.claude/.credentials.json` | CLI refreshes it itself; a copy exported into env would not |
| **`claude setup-token`** | **1 year** (stated by the CLI) | printed once → store in vault | none; re-issue before expiry |

Rule: **for the shim use only `setup-token`.** The ACP card token is fine for a quick
ACP session, not for a service that must run for months.

Symptom of an expired token: every Claude Code profile in Vellum fails, shim log shows
`Failed to authenticate. API Error: 401 OAuth access token has expired`. Check:
`journalctl --user -u claude-shim --since -1h | grep 401`.
Fix: step 2 below, then `systemctl --user restart claude-shim` (run.sh reads the vault
only at start).

### 2. Obtain the OAuth token (headless VM, browser elsewhere)

**Use `claude setup-token` — it issues a 1-year token** (see 1b for why not the ACP card).

`setup-token` is an interactive Ink TUI; run it in tmux so it survives the bash timeout:

```bash
tmux new-session -d -s st -x 200 -y 50
tmux pipe-pane -t st -o 'cat >> /tmp/st.log'
tmux send-keys -t st "PATH=$HOME/.local/bin:\$PATH claude setup-token" Enter
sleep 8
tmux capture-pane -t st -p -J -S -50 | tr -d '\n' \
  | grep -o 'https://claude.com/cai/oauth/authorize?[A-Za-z0-9%&=_.-]*state=[A-Za-z0-9_-]*'
```

Give the URL to the user. They log in with their Claude subscription and get a code
`XXXX#STATE` back on the page (no callback to the VM — redirect goes to platform.claude.com).
Paste it in:

```bash
tmux send-keys -t st '<code#state>' Enter
# Gotcha: the TUI enables kitty keyboard protocol; a plain Enter may be ignored.
# If the prompt still shows asterisks after ~10 s, send the kitty-encoded Enter:
tmux send-keys -t st -l $'\e[13u'
TOK=$(grep -o 'sk-ant-oat01-[A-Za-z0-9_-]*' /tmp/st.log | head -1)
assistant credentials set --service acp --field claude_oauth_token --generated \
  --allowed-tools acp_spawn "$TOK"
shred -u /tmp/st.log; tmux kill-server
systemctl --user restart claude-shim
```

`claude auth status` will still say `loggedIn: false` — setup-token does not write
`~/.claude/.credentials.json`; the token lives only in the vault and reaches the SDK via
`CLAUDE_CODE_OAUTH_TOKEN`. That is fine.

Verify: `assistant credentials list | grep acp` shows `acp:claude_oauth_token`.

### 3. Create the shim project

```bash
mkdir -p ~/claude-shim && cd ~/claude-shim
bun init -y
bun add @anthropic-ai/claude-agent-sdk
cp {baseDir}/scripts/{server.js,run.sh,package.json,bun.lock,tsconfig.json} ~/claude-shim/ && (cd ~/claude-shim && bun install)
cp {baseDir}/scripts/claude-shim.service ~/.config/systemd/user/   # fix paths/assistant name in run.sh + unit first
```

`server.js` (full source in `{baseDir}/scripts/server.js`, ~550 lines):
- `GET /v1/models` → `claude-opus`, `claude-sonnet`; `GET /chats` (alias `/pool`) → live
  chats, sessions, idle seconds, waiters, plus `oneshot: [{cli,label,model}]`,
  `maxOneshot`, `oneshotWaiters`
- `POST /v1/chat/completions` (SSE), model id `claude-X` → SDK model `X`
- Classes: `Cli` (one `claude` process via streaming-input `query()`, `close()` kills),
  `Chat` (per key: sessionId, sha1 list of fed blocks, sysHash, lock serialising
  requests, `park()`), `manager` (Map of chats, `spawn` with MAX_LIVE cap + LRU park,
  reaper every 60 s, SIGTERM parks all)
- `inputBlocks(messages)` = user + tool_result blocks only (system → `systemPrompt`,
  assistant turns are already in the CLI transcript). `systemText(blocks)` = Vellum
  system messages + tool contract (`<tools>` defs + "emit ONLY `TOOL_CALL: {...}`")
- Output with tools is **buffered** so TOOL_CALL lines can be detected; parsed calls →
  `delta.tool_calls` + `finish_reason: "tool_calls"`, else content + `stop`; fabrication
  guard truncates at a model-written `<tool_result`; `<invoke>` XML fallback takes the
  first call only
- SDK options: `tools: [], allowedTools: [], permissionMode: "bypassPermissions",
  settingSources: [], resume?, systemPrompt?`, `env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN }`
- Env knobs: `SHIM_TOOL_MODE` (`mcp` | `text`), `SHIM_DEBUG_MCP` (log in-process tools/list count per spawn), `SHIM_MAX_LIVE` (8), `SHIM_MAX_ONESHOT` (32), `SHIM_IDLE_TTL_SEC` (3600),
  `SHIM_SESSIONS_DIR` (`./sessions`), `SHIM_PORT` (8317 — side-port testing)

Three instances run on this VM: `:8317` claude-shim (text/prompt-contract tools, stable,
never restart), `:8318` shim-mcp-test (`SHIM_TOOL_MODE=mcp`, experimental), `:8320` shim-v3
(`server-v3.js`: verbatimPrompts, fallbackModel, effort switch via updateSettings, precompute
compaction, context_usage/rate_limits/actual_model in usage — see lessons 33–34 and
`scripts/server-v3.js`).
- Thinking: always spawned with `display:"summarized"`; raw CoT never available on
  subscription (redacted by Anthropic), summaries are
- `Bun.serve({ idleTimeout: 255 })` — default 10 s kills slow SDK spawns
- Log lines: `[req]`, `[cli<N> <key>] init tools=<n> mcp=[vellum:connected] expected=<n>` (the two
  numbers MUST match — see Gotchas), `[res] tool_calls(mcp)=bash,file_read pending=…`,
  `[mcp] resolved N pending tool result(s)`, `[sess] … continuing in-flight run`,
  `[sess] <key> cli<N> spawn|resume|live blocks=… seen=…`,
  `[sess] … served #n … cache_read=…`, `[sess] … park (idle|evict|sigterm|sysprompt)`,
  `[usage] …`. Read with `journalctl --user -u claude-shim -f`.

**Do not restart the shim casually** — SIGTERM parks sessions correctly, but a restart
still costs every live chat a resume + the first request after it is slower.

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

### 7. Vellum local patches this depends on (fork `anatolix/vellum-assistant`, branch `local-patches`)

Two of the five local patches on that branch exist for this shim; without them the shim
still works but every request is keyless (throwaway process, no cache):

- **`prompt_cache_key` forwarding** (commit 239cd4af): `providers/retry.ts` adds
  `openai-compatible` to `PROMPT_CACHE_KEY_PROVIDERS`;
  `providers/openai/chat-completions-provider.ts` puts `configObj.promptCacheKey` on the
  wire as `prompt_cache_key`. Vellum sets it to the conversation id.
- **`X-Vellum-Trust` header** (commit fcfcdc50): `agent/loop.ts` stamps
  `providerConfig.actorTrustClass`; `retry.ts` sends it as a header for openai-compatible
  providers only. Consumed by Richard's wrapper (step 8) to set `VELLUM_MCP_TRUST`.

Re-apply after every `bun install -g vellum` upgrade (cherry-pick the branch), then
`systemctl --user restart vellum-<name>.service`.

### 8. Optional: RichardAtCT/claude-code-openai-wrapper with Vellum tools over MCP

Alternative backend (Python/FastAPI, `claude-agent-sdk`), useful to compare behaviour.
Fork with two patches: `anatolix/claude-code-openai-wrapper` (`MCP_SERVERS_FILE`,
`MCP_MAX_TURNS`, `X-Vellum-Trust` → `VELLUM_MCP_TRUST` in the stdio server env).

```bash
git clone git@github.com:anatolix/claude-code-openai-wrapper.git ~/richard-shim
conda create -n richard python=3.12 -y && conda activate richard && pip install -e ~/richard-shim   # or poetry
cp {baseDir}/scripts/richard-mcp_servers.example.json ~/richard-shim/mcp_servers.json   # fix paths
cp ~/richard-shim/run.example.sh ~/richard-shim/run.sh                                 # fix paths
echo 'MCP_SERVERS_FILE=/home/<user>/richard-shim/mcp_servers.json' >> ~/richard-shim/.env
# systemd user unit: ExecStart=/home/<user>/richard-shim/run.sh, port 8000
assistant inference providers create richard --provider openai-compatible --auth none \
  --base-url http://127.0.0.1:8000/v1 --model claude-opus-4-1 --model claude-sonnet-4-5
```

`vellum-mcp.ts` (in `{baseDir}/scripts/`, lives at `~/claude-shim/vellum-mcp.ts`; needs
`@modelcontextprotocol/sdk` — resolved from Vellum's global node_modules, no extra
install) env:

| var | meaning |
|---|---|
| `VELLUM_WORKSPACE_DIR`, `VELLUM_DATA_DIR`, `VELLUM_CLOUD=local` | as for the `assistant` CLI |
| `VELLUM_MCP_INCLUDE` / `VELLUM_MCP_EXCLUDE` | comma lists; default exclude = UI-only tools. Richard config also excludes bash/write/host/skill_execute |
| `VELLUM_MCP_TRUST` | `unknown` (default: approval-gated tools denied) or `guardian` (**no approval prompts at all** — only via the trust header, never hard-coded) |
| `VELLUM_MCP_TOOL_TIMEOUT_SEC` | per-process override of `timeouts.toolExecutionTimeoutSec` (config.json untouched). 300 in our config — agentic `recall` on a slow background model takes 17–120 s+ |

Test the bridge alone: `bun run {baseDir}/scripts/mcp-time.ts` (times one `recall` call
through the MCP client). Test end-to-end: `curl :8000/v1/chat/completions -H 'Authorization: Bearer x'
-H 'X-Vellum-Trust: guardian' …` — journal shows `MCP servers attached: ['vellum'] trust=guardian`.
Without the header recall answers «only available to the guardian». `Authorization` header
is required by the wrapper even with `--auth none` on the Vellum side (Vellum always sends one).

Observed: Richard's per-request process spawn (no session continuation) is noticeably
slower than the per-chat shim; kept alive for comparison only.

### 9. MCP tool mode — how the pieces fit (server.js, Sep 30)

Read this before touching `buildMcp` / `waitForVellum` / the request layer.

- **One MCP server instance per CLI process.** `buildMcp(tools)` returns
  `{make, names, sig}`; `make()` is called at every spawn. A `createSdkMcpServer` instance
  shared by two `query()` calls silently leaves the second process without tools.
  Only zod shapes are cached (`shapeCache`, keyed by name+schema).
- **Schema → zod, validated through the SDK's own converter.** `jsonSchemaToZod` handles
  string/number/integer/boolean/null/enum/array/object/anyOf/oneOf; unknown → `z.unknown()`;
  objects are `z.looseObject` (never `z.record` — see Gotchas). `shapeFor()` builds a
  throwaway server with the single tool and runs its `tools/list`; a shape the SDK cannot
  convert falls back to an open object **for that tool only**. `buildMcp` is async because
  of this check.
- **Handler ids.** The handler keys itself by `extra._meta["claudecode/toolUseId"]` (the real
  `toolu_…` id); `name#seq` provisional ids + `rekeyPending` remain as fallback.
- **Batch = one assistant message.** The CLI emits one `assistant` message per content
  block (~140 ms apart), so the batch is closed on `stream_event message_stop` (2 s timer
  fallback), not on the first `tool_use`. Handlers run **sequentially** inside the CLI —
  the second one fires only after the first resolves — so results Vellum returns for
  handlers that have not fired yet go to `earlyResults` (only for ids in `emittedToolIds`)
  and `waitForVellum` serves them without parking. Net effect: N parallel tool calls =
  one Vellum round trip.
- **Attach, don't re-feed.** A request whose unseen blocks are all tool results resolves
  handlers and `cli.attach(onMsg)`es to the in-flight run. `tool_use` blocks emitted while
  nobody was listening are buffered in `cli.unobserved` and replayed on attach.
- **Tool set changes between turns** (skills loaded/unloaded): `Cli.setTools` compares
  `sig` and calls `q.setMcpServers({vellum: make()})` on the live session.
- **Timeouts.** `TOOL_WAIT_MS` = 1 h; a handler nobody answers resolves with an `isError`
  text. `extra.signal` never fires on query close — the shim cleans up itself. The CLI
  itself has no ceiling on a hanging handler (tested 4 min+).
- **Resume with an open tool_use** works: the CLI logs "tool interrupted", the session
  stays usable.
- In mcp mode tool-bearing requests are never one-shot (the handler must outlive the
  HTTP response); `sent` hashes are saved *before* `cli.send`.

Side-by-side testing: run a second instance on another port under systemd
(`systemd-run --user --unit=shim-mcp-test … -E SHIM_PORT=8318 -E SHIM_TOOL_MODE=mcp
-E SHIM_SESSIONS_DIR=/tmp/shim-mcp-sessions`; background children of a tool shell die with
it), register it as a separate provider connection (`claude-code-mcp`, profiles
`claude-code-mcp-*`) and switch a chat to it. Batch harness: `{baseDir}/scripts/test-mcp-batch.sh`.
To drive a real Vellum agent turn on that profile without a human:
`assistant conversations new t --json` → `assistant inference session open <profile>
--conversation-id <id>` → `assistant conversations wake <id> --persist --hint '<task>'`.

## Verification

Three curl tests against the shim (`{baseDir}/scripts/test-shim.sh` runs all three):

1. No tools → `content: "Париж."`, `finish_reason: stop`
2. With `tools=[get_weather]` + "используй инструмент" → `delta.tool_calls[0].function.name == get_weather`, `finish_reason: tool_calls`
3. History with `assistant.tool_calls` + `role: tool` result → final text, `stop`

End-to-end: open a **new** Vellum chat on profile *Claude Code (Opus)*, ask for
`uname -a` — bash must run.

Session/cache check: send 3–4 turns in one chat, then
`journalctl --user -u claude-shim -n 30 | grep -E 'served|usage'` — request #2+ must show
`cache_read` close to the full prompt and `[sess] … live blocks=1`. `curl :8317/chats` lists
the chat with `served` growing and one `session` id. Short synthetic tests show
`cache_read=0` — below Anthropic's cache minimum; measure on a real chat with the Vellum
system prompt.

Park/resume check: `SHIM_IDLE_TTL_SEC=20 bun run server.js` on a side port, tell the model a
secret word, wait 30 s (`[sess] … park (idle)`), ask for the word — `resume` in the log and
the word comes back.

## Gotchas

- **No tools in Vellum = shim problem, not Vellum config.** There is no per-profile
  "enable tools" switch. If the shim passes `tools: []` to the SDK and ignores
  `body.tools`, every session on that profile is text-only.
- `CLAUDE_CODE_OAUTH_TOKEN` must be passed via `options.env`; the SDK child does not
  inherit implicitly. `token_len=0` in the log → run.sh could not reveal the credential
  (usually missing `VELLUM_WORKSPACE_DIR` in the systemd env).
- With tools present the reply is not streamed token-by-token — whole answer at once.
  Vellum system prompts are large; first reply on Opus takes 15–30 s.
- Prompt-contract calling is not schema-enforced. The shim guards against the worst
  case — the model writing a fake `<tool_result>` and continuing as if the tool ran —
  by truncating output at the first self-written `<tool_result` and after the first
  parsed TOOL_CALL. Still: spot-check paths/numbers the model cites.
- Keep `tools: [], allowedTools: []` in the SDK options. Enabling Claude Code's native
  tools would let the model touch the filesystem outside Vellum's trust rules.
- **`init tools=0 mcp=[vellum:connected] expected=N`** → the MCP server connected but its
  `tools/list` threw, and the CLI silently runs with no tools while the model, seeing tool
  talk in the history, writes tool calls as text ("trash in the chat"). Cause seen: a zod
  construct the SDK's *bundled* zod core cannot convert (`z.record` → `ctx.deferred.push`).
  One bad tool empties the whole list. Fixed by `looseObject` + per-tool validation
  (`shapeFor`); if it recurs, `SHIM_DEBUG_MCP=1` and `SHIM_DUMP_TOOLS=/tmp/tools.json`
  (write the request's tools to disk) locate the culprit.
- **Probe scripts must run from `~/claude-shim`.** A bun script in `/tmp` resolves `zod`
  from `~/.bun/install/cache`, not from the shim's `node_modules` — a different copy that
  passes tests the shim fails.
- Restarting the mcp shim while a handler is parked (a Vellum tool is running for a chat
  on that profile) loses that tool result; the chat recovers on resume ("tool interrupted")
  but the turn is wasted. Restart from a chat on another profile.
- Bun `idleTimeout` default (10 s) → Vellum shows "Could not connect to the AI provider".
- Rollback: `SHIM_TOOL_MODE=text` in the unit env (old contract, same binary); or `cp server.js.bak-pre-mcp server.js && systemctl --user restart claude-shim`.
- `prompt_cache_key` missing in `[req]` log (`key=-`) → the Vellum patch (step 7) is not
  applied or the daemon was not restarted; everything runs keyless/ephemeral.
- Every `[sess]` line says `spawn blocks=N` with N = whole history → the block hashes do not
  match what was fed before (e.g. Vellum rewrote earlier messages). Expected only after
  compaction (one summary block) or a failed resume.
- `sessions/` grows one JSON per parked chat; harmless, delete old ones by mtime if you care.
- Anthropic subscription *session limits* («You've hit your session limit · resets …») hit
  all chats at once; the shim just relays the error text. Parallel resolve-style batch jobs
  burn through it fast — 4 threads, not 16.

See `{baseDir}/references/failure-modes.md` for more.

Why the code looks the way it does, and every problem hit while building it: `{baseDir}/references/lessons-learned.md`.
