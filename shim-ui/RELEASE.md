# Shims UI 1.0.0 — 2026-10-05

- Server-only native UI sidechannel shared by Claude v3 and Codex v2.
- One Cached / Uncached / Out line per model response, including tool-call responses and first full-history restoration. Optional cache-write counter; absent usage shown as unknown, never a fabricated zero.
- Operational diagnostics use 🔴 native cards bound to the exact Vellum reply ID. No new synthetic notice tools, assistant prose, or reasoning fallbacks. Existing legacy notices cleaned on input with source indices preserved.
- Full-history loading is explicitly reported. Real HTTP/SSE failures remain errors.
- New shim-ui 1.0.0 plugin persists only native ui_surface blocks through post-model-call. Real OpenAI and Anthropic serializer tests verify no UI warnings or counters reach the model after switching providers.
- Requires Vellum 0.12.6, exportSourceIds (wire v3 reply_id), plugin activation, and SHIM_UI_SOCKET on each shim. Disabled/missing sidechannel is non-fatal and never falls back to model-visible text.

No client upgrade is required. Disable the old token-usage-card pilot to prevent duplicates. No changes to native tool permissions or inference profile selection.

## 1.0.1 — compact display

One summary card per reply; updates in place. Routine startup/history/reasoning diagnostics stay in logs. Up to two short warning labels plus an extra-warning count, with full warning strings retained in UI-only diagnostic data. Out is preserved. Hot reload requires no shim, Vellum or client restart.
