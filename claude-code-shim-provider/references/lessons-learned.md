# Lessons learned: building the shim (war stories)

What actually went wrong while building this, in order, and what fixed it.
Quick symptom→fix lookup is in `failure-modes.md`; this file is the *why* behind the code.

## 1. "Profile has no tools" is not a Vellum setting
Symptom: on the Claude Code profile the assistant printed tool invocations as plain
text (`<invoke name="bash">…`) instead of calling them.
Wrong first diagnosis: "enable tools for Opus in Vellum config". No such toggle exists.
Real cause: the first shim had `tools: [], allowedTools: []` and never read `body.tools`.
The model never saw a single tool definition.
Lesson: when a profile misbehaves, curl the provider directly with a `tools=[…]` body
before touching Vellum config.

## 2. The Agent SDK does not take OpenAI tool definitions
The SDK only knows Claude Code's own tools (Bash/Read/…). Enabling those would let the
model act outside Vellum's trust rules. Solution: a text contract. Tools are rendered into
the prompt as `<tools>[…]</tools>`; the model answers with one-line
`TOOL_CALL: {"name":…, "arguments":{…}}`; the shim parses those into real OpenAI
`tool_calls` deltas. Vellum stays the executor.

## 3. Streaming vs. tool detection
You cannot know a reply is a tool call until you see the `TOOL_CALL:` line, so with tools
present the reply is buffered and sent at once. Plain requests (no tools) still stream.
Cost: first reply on Opus with Vellum's ~10k-token system prompt takes 15–30 s.

## 4. History must round-trip
Vellum sends back `assistant.tool_calls` and `role: tool` messages. The shim re-renders
them as `TOOL_CALL:` lines and `<tool_result name=…>` blocks; otherwise the model loses
track of what it already ran. `content` may be a string OR an array of parts —
`contentToText` handles both.

## 5. Bun idleTimeout kills slow spawns
Default `Bun.serve` idleTimeout is 10 s. SDK cold spawn takes longer → Vellum shows
"Could not connect to the AI provider". Fix: `idleTimeout: 255` (the max).

## 6. Token not reaching the SDK (`token_len=0`)
systemd user units do not inherit `VELLUM_WORKSPACE_DIR`, so `assistant credentials
reveal` in run.sh silently returned nothing. Export the Vellum env vars in run.sh and
pass the token explicitly via `options.env`.

## 7. Fabricated tool results — the dangerous one
Opus glued a `TOOL_CALL:` onto the end of a previous text line; the regex was anchored at
line start, the call was not parsed, nothing ran. With `maxTurns: 1` nothing stopped the
model: it wrote its own `<tool_result>` blocks and produced a confident diagnosis of bugs
in files and tables that do not exist. The "analysis" read exactly like a real one and
even got saved to memory as fact before anyone checked.
Fixes in `parseToolCalls`:
- regex no longer anchored at line start;
- a model-written `<tool_result` truncates the output there;
- everything after the first parsed TOOL_CALL is dropped;
- contract says: STOP after TOOL_CALL, never write `<tool_result>`;
- if the whole reply was fabricated → visible `[shim] …` notice, not an empty turn.
Code gotcha while fixing: the first version *stripped* fake blocks and kept parsing — the
unit test happily extracted a call that came AFTER a fake result (the model's imagined
next step). Truncating is the only safe option.
Human rule: spot-check any path or number the Claude Code profile cites before acting.

## 8. The guard bit its own tail (next morning)
The fabrication check was a global `text.search(/<tool_result\b/)`. The next day the
model emitted a perfectly valid TOOL_CALL whose JSON argument was a shell heredoc
*writing this very file*, which contains the words "`<tool_result`". The guard cut the
JSON in half, `JSON.parse` failed, and the whole call landed in chat as text.
Fix: the check is now line-level and runs only on lines that are NOT a parsable
TOOL_CALL. A TOOL_CALL that merely mentions `<tool_result` inside its JSON is fine.
Lesson: any content-based guard must exclude the payload it is protecting. Unit-test
parseToolCalls with a call whose arguments contain your own sentinel strings.

## 9. Patching JS through Python heredocs
Editing server.js via `python3 - <<'EOF'` with regexes inside means double escaping
(`\\s` in Python source → `\s` in JS). Use raw strings (`r'''…'''`) and always unit-test
the extracted function after the patch (`new Function(src.slice(…))`) before restarting
the service. `/tmp/ptest.js` pattern: slice from `const TOOL_CALL_RE` to
`function sseChunk`, eval, run 5–6 cases.

## 10. Short-lived OAuth token
The token from Vellum's inline ACP "Connect Claude Code" card died after ~10 h
(`401 OAuth access token has expired` in the shim log at 05:47). Use `claude setup-token`
— a 1-year token. `claude auth status` then still says `loggedIn: false`; normal, the
token lives in the vault, not in `~/.claude`.

## 11. Driving the setup-token TUI headless
- Run it in tmux. A plain background run dies with the bash tool timeout, and the OAuth
  `state` is tied to that process — a new run means a new URL, the old code is useless.
- `tmux pipe-pane -o 'cat >> /tmp/st.log'` to catch the token; `shred -u` the log after.
- The Ink TUI turns on kitty keyboard protocol: `tmux send-keys Enter` may be ignored.
  Send the kitty-encoded Enter: `tmux send-keys -t st -l $'\e[13u'`.
- The code comes back as `CODE#STATE` on platform.claude.com — no loopback callback, so
  the phone/laptop can be anywhere.
- Store with `assistant credentials set --generated` (the value came from a CLI, not chat).

## 12. Assistant-side lessons
- On effort `max` the model "wrote code in its head" for minutes and looked hung.
  Write the plan/code to a file first; medium/high effort is enough for this work.
- Announcing "now I'll do X" without calling a tool in the same turn → empty turn.
- git push to the skills repo needs the explicit key:
  `GIT_SSH_COMMAND="ssh -i <workspace>/.ssh/id_ed25519 -o IdentitiesOnly=yes"`.
- Keep the skill's `scripts/server.js` byte-identical to the running one (`diff -q`)
  before every commit; otherwise the runbook drifts from reality within a day.
