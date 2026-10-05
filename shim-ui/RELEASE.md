# Shims UI 1.0.0 — 2026-10-05

- Server-only native UI sidechannel shared by Claude v3 and Codex v2.
- One Cached / Uncached / Out line per model response, including tool-call responses and first full-history restoration. Optional cache-write counter; absent usage shown as unknown, never a fabricated zero.
- Operational diagnostics use 🔴 native cards bound to the exact Vellum reply ID. No new synthetic notice tools, assistant prose, or reasoning fallbacks. Existing legacy notices cleaned on input with source indices preserved.
- Full-history loading is explicitly reported. Real HTTP/SSE failures remain errors.
- New shim-ui 1.0.0 plugin persists only native ui_surface blocks through post-model-call. Real OpenAI and Anthropic serializer tests verify no UI warnings or counters reach the model after switching providers.
- Requires Vellum 0.12.6, exportSourceIds (wire v3 reply_id), plugin activation, and SHIM_UI_SOCKET on each shim. Disabled/missing sidechannel is non-fatal and never falls back to model-visible text.

No client upgrade is required. Disable the old token-usage-card pilot to prevent duplicates. No changes to native tool permissions or inference profile selection.

## 1.0.1 — compact display

One summary card per reply; updates in place. CLI startup is folded into the next real token card instead of being hidden or creating its own card. All-unknown token lines are omitted entirely. Routine history/reasoning diagnostics stay in logs. Up to two short warning labels plus an extra-warning count, with full warning strings retained in UI-only diagnostic data. Out is preserved. Hot reload requires no shim, Vellum or client restart.

## 1.1.0 — turn roll-up

One rolling usage card per chat instead of one card per reply step. Each new step's card is shown on the newest reply row holding up to 5 recent step lines (`Cached … · Uncached … · Out …`, one per step, hard-broken); the superseded card is dismissed live via `ui_surface_dismiss` AND stripped from its persisted message row via `updateMessageContent`, so reload does not resurrect it. Updates within a single step still edit the same surface in place (no dismiss). Warnings ride their step's line unchanged.

## 1.2.0 — scoped roll-up

Roll-up applies ONLY to token cards, and only within a silent run (thinking + tool calls, no visible text). The run breaks — old card stays, a fresh card starts — as soon as the model writes any text or a human text message arrives; tool_result-only user rows do not break it. Warnings are back on their own separate per-reply cards (never rolled into the token line), as in 1.0.0.

## 1.3.0 — startup unglued

CLI startup is its own separate card again, published immediately on the notice (no waiting for usage, never merged into the token line, never rolled). Token cards roll only among themselves within a silent run; warnings keep their own cards. Three card kinds, three surface suffixes: :startup, :summary, :warnings.
