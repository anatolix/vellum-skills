# shim-ui native Vellum plugin

Server-only plugin that turns shim sidechannel events into native `ui_surface` content blocks. It is intended to replace the old `token-usage-card` plugin; do not run both. It has no conversation allowlist: supported shim replies in all conversations get UI-only surfaces. No assistant text, tool call/result, message row, prompt mutation, direct SQL write, or usage aggregation is produced.

## Install and activate (Vellum 0.12.6)

1. Copy this whole `shim-ui/` directory into the assistant workspace's `plugins/shim-ui/`.
2. Set its `config.json` to `{ "enabled": true }`. Disable the old `token-usage-card` plugin via native plugin IPC before enabling this plugin, to avoid overlapping cards.
3. Reconcile/enable through the daemon's native plugin IPC (`plugins_disable` for the old id, then `plugins_enable` for `shim-ui`). On 0.12.6, the CLI enable command only changes the sentinel and does not initialize hooks; use the native IPC route. No daemon restart is needed.
4. Each shim must publish its `hook_event` through `/events/publish` local IPC and await completion before closing the provider stream. Payload uses `hookName: shim-ui`, owner `{kind:'plugin',id:'shim-ui-transport'}`, and `detail` kinds `notice`, `usage`, `complete` as specified in the transport contract. Emit `complete` once per HTTP response, even with no usage. Notice text is raw (no leading red marker).

The listener and hook dynamically import private CRUD from the installed 0.12.6 runtime only; the plugin refuses other versions. Native cards publish `ui_surface_show` with the reserved reply row's message ID. The post-model-call hook selects only the latest unfinalized assistant row and requires exact `conversationId + replyId` binding before appending blocks to the hook's in-memory `ctx.content`; host persistence occurs normally afterward. OpenAI and Anthropic serializers are tested to drop `ui_surface` on future requests.

Usage line: `Cached x · Uncached y · Out z`, with optional `· Write w`. Prompt tokens are inclusive; uncached subtracts cached and cache-write. Unknown values render `—`, never zero. Version 1.0.2 uses ONE compact card per reply: a CLI startup label (when a new CLI was launched) merged with real token counters, plus at most two short warning labels and an additional-warning count. Updates replace that same surface. Startup never creates a separate card, and an all-unknown `Cached — · Uncached — · Out —` line is omitted entirely. Successful history loading/compaction, model switching and unavailable reasoning-summary notices remain in shim logs, not in cards. Actual warnings (lost calls, missing IDs, failures) remain visible; partial ID coverage is shortened to `Без ID: n/total`. No client or daemon restart is needed.

## Tests

From this directory run `VELLUM_WORKSPACE_DIR="$(mktemp -d)" bun test tests`. Provider serializer tests import the installed v0.12.6 runtime; unit tests cover binding, pre-finalized row staging, foreign events, escaping, missing usage, merging, deduplication and preservation of all existing block types.

## Transport exclusions

This event schema carries no request key, call-site, or compaction marker, so the receiving plugin cannot independently distinguish `router-oneuse`, background/compaction, or a shim conversation-key alias. Shim publishers MUST suppress those events before publication and publish only for real UUID conversation/reply IDs. See integration note in the implementation handoff.

### Shim setup

For each systemd user unit (`shim-v3.service`, `codex-shim.service`), add a **non-secret** drop-in:

```ini
[Service]
Environment=SHIM_UI_SOCKET=/absolute/workspace/assistant.sock
```

Use the assistant's real resolved socket path (long workspace paths use `/tmp/vellum-ipc/…-assistant.sock`). Run `systemctl --user daemon-reload`, then restart the two shim units only after active streams finish. Never use `vellum sleep` / `vellum wake` for deployments. Keep `exportSourceIds: true` on the main-agent shim profiles: `_vellum.reply_id` is the card/message binding. Background calls, dry runs, compaction and router-oneuse never publish UI events. Missing socket/row/usage fail open. Warnings are capped at 40 per response and IPC is bounded to 750 ms per event.

Rollback: disable `shim-ui` through native `plugins_disable` IPC, remove the non-secret drop-ins, restore prior shim scripts and restart idle shim units. Re-enable the old pilot only if desired. No Vellum/client restart is necessary.
