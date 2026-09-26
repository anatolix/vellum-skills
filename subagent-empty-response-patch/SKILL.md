---
name: "Subagent empty-response patch (re-query nudge)"
description: "Fix for the Vellum platform bug where subagents die silently after exactly one tool call (empty post-tool LLM response). Documents the confirmed root cause, the one-line local patch to the empty-response hook, verification procedure, and the upstream issue/PR. Re-apply after every upgrade until the PR merges."
metadata:
  vellum:
    activation-hints:
      - Subagents die after exactly one tool call with no output and no error
      - After a vellum upgrade, subagents broke again — need to re-apply the patch
      - Wants the story/links of the upstream issue and PR for this bug
    avoid-when:
      - The platform version already includes the upstream fix (check PR merge status first)
    category: system
---

# Subagent empty-response patch

## The bug

On Vellum v0.12.2–0.12.4 (and still unfixed in v0.12.5), subagents die after completing **exactly one tool call**. After the first tool-call result returns, the next LLM call comes back **empty**; the runner marks the agent `completed` with no output. Clean logs, no OOM, no error state — silent death. Reproduced across multiple fleets and models (Fable, Kimi K3 Medium, Sonnet) — not model-specific.

## Root cause

The `empty-response` plugin has a post-model-call hook that re-queries the model with a nudge when a response comes back empty — but only for the main agent. The gate:

```ts
if (ctx.callSite !== "mainAgent") return;
```

Subagents (`callSite === "subagentSpawn"`) hit the same empty responses (providers occasionally return empty completions) but get no nudge/retry, so the empty response is treated as final and the agent "completes" silently.

## The patch (one line)

File (global bun install):

```
~/.bun/install/global/node_modules/@vellumai/assistant/src/plugins/defaults/empty-response/hooks/post-model-call.ts
```

Change the gate (~line 211) to:

```ts
if (ctx.callSite !== "mainAgent" && ctx.callSite !== "subagentSpawn") return;
```

Then restart the daemon:

```bash
systemctl --user restart vellum-<assistant>.service
```

**Always back up first** (`cp post-model-call.ts post-model-call.ts.bak-<date>`).

## ⚠️ Patch dies on every upgrade

`bun install -g vellum` overwrites the file. **Re-apply after every upgrade** until the upstream PR merges. As of v0.12.5 (Sep 25, 2026) the fix is NOT included.

## Upstream

- Issue: **vellum-ai/vellum-assistant#43327** — "Subagents die after 1 tool call (empty post-tool response, no nudge)"
- PR: **vellum-ai/vellum-assistant#43328** — `fix(assistant): re-query nudge for subagents on empty post-tool response` (from fork anatolix/vellum-assistant, branch `fix/subagent-empty-response-nudge`). Closes #43327 on merge.

Check merge status before assuming the patch is still needed:

```bash
assistant oauth request github GET /repos/vellum-ai/vellum-assistant/pulls/43328
```

## Verification

Spawn a control fleet of 2–3 subagents (see the companion skill `subagent-survival-diagnostic` for the procedure). Each must survive 3 sequential tool calls (e.g. file_read × 2 + notify_parent). Post-patch on this instance: 3/3 control agents survived, plus a 7-agent fleet doing multi-step bash loops, plus large-input (153k chars) reads on the balanced profile.

## History

- **Sep 23, 2026** — bug confirmed across three waves of subagent fleets (42 + 8 agents), multiple models.
- **Sep 24 ~15:04** — root cause found, one-line local patch applied, verified working. Issue #43327 filed, PR #43328 opened the same day.
- **Sep 25** — v0.12.5 released (102 commits); PR not included. Patch still required.
