# Failure modes

| Symptom | Check / corrective action |
| --- | --- |
| Immediate 400 `missing_session_key` | Inspect outgoing `prompt_cache_key` or `X-Conversation-Id`. Re-apply the optional shared transport patch after a Vellum upgrade, then safely restart its actual daemon. Keep strict mode enabled. |
| New thread / replay on every tool round | Compare `[req]` key source, fingerprint, model and `[guard]` notices. Fix stable conversation identity rather than raising replay limits. |
| Second tool request hangs | Ensure the reader does not await a parked request, state is saved at parking, the new handler precedes RPC replies, and live threads are not resumed from disk. Check RPC ID 0. |
| `dynamicTools requires experimentalApi` | Confirm initialize capabilities and installed app-server protocol version. |
| `dynamic tool response was invalid` | Inspect captured tool/result shape and matched parked IDs. A timed-out concurrent tool batch can leave outstanding calls; retry only read-only work after outstanding responses settle. Do not silently repeat external writes. |
| No readable thinking | Check emitted SSE / conversation exports and `tokenUsage.last.reasoningOutputTokens`. Summary request must be per-turn; real summary availability is model-dependent. Positive tokens with no readable text should produce one fallback at the response boundary. |
| Thinking is persisted but absent visually | Treat as a client-rendering issue, not proof the upstream returned nothing. Never claim UI success from transport logs alone. |
| Silent, slow turn | `[turn]` first-event timings and 15-second heartbeat; inspect private rollout only if necessary. Native internal tools should be off; usage is not a live ticker. |
| Profile probe/job fails | No chat identity is intentionally rejected before inference. Do not spend model quota to satisfy background probes. |
| Thread lost after restart | Disk resume can fail; the adapter removes that session mapping and asks for retry. Avoid restarting mid-tool pause. Do not delete all sessions. |
| Tiny empty v1 resume reply | v1 resume flags differ from first exec; inspect stderr/journal. It is not the default v2 path. |
| E2BIG in legacy exec | Feed the prompt on stdin, not argv. |
| `/usr/bin/env: node` from Codex wrapper | Use the package's native binary or install the expected runtime; do not confuse wrapper failure with auth failure. |
| Auth expiry / 401 | Re-run official device login. Do not print or upload `~/.codex/auth.json`. |
| Unexpected permission/sandbox behavior | v2 defaults to `workspace-write`, native tools off, caller-owned dynamic tools. Do not enable danger/native modes merely to quiet a permission error. |

Useful private diagnostics:

```bash
journalctl --user -u codex-shim.service --no-pager | grep -E '\[guard\]|\[turn\]|\[req\]|\[res\]'
curl -fsS http://127.0.0.1:8321/chats
assistant conversations export <conversation-id> --format json
```

Exports, journal content and `/chats` metadata may be private; use them locally, not as commit artifacts. Do not use `pkill -f server-v2` from a shell whose own command line contains that string: it can kill the calling shell. Prefer a planned `systemctl --user restart codex-shim.service` after the active turn.

## Client interruption / closed SSE controller (Oct 4)

A client abort used to close the ReadableStream controller while late app-server
reasoning deltas still called `enqueue()`. The exception escaped the JSON-RPC
notification reader and killed the entire shim (`ERR_INVALID_STATE`,
`Controller is already closed`), affecting unrelated conversations.

Chat and compaction now use `sse-writer.js`: cancellation marks the writer closed,
close is idempotent, and the closed-controller TypeError is safely discarded.
Other errors still propagate. Upstream turns, parked tool RPCs, persistence and
other chats are not interrupted or deleted by an HTTP disconnect.

Quota-free regressions: `bun test scripts/sse-writer.test.js` and
`python3 tests/test-disconnect.py` (fake app-server; same-process recovery).
