// Count model calls once, not once per stream/assistant event or HTTP attach.
// A Cli owns this ledger throughout the SDK run (including MCP tool pauses).
const fields = ["input", "output", "read", "write"];
const valid = n => Number.isSafeInteger(n) && n >= 0;
const zero = () => Object.fromEntries(fields.map(k => [k, 0]));
const names = { input: "input_tokens", output: "output_tokens", read: "cache_read_input_tokens", write: "cache_creation_input_tokens" };
const normalized = u => Object.fromEntries(fields.map(k => [k, valid(u?.[names[k]]) ? u[names[k]] : 0]));

export class ClaudeUsageAccounting {
  constructor(saved = null) {
    this.pending = { ...zero(), ...saved?.pending };
    this.startRun();
  }
  startRun() {
    this.messages = new Map();
    this.currentId = null;
    this.sequence = 0;
    this.runAccounted = zero();
    this.resultFloor = zero();
  }
  snapshot() { return { pending: { ...this.pending } }; }
  account() {
    const sum = zero();
    for (const u of this.messages.values()) for (const k of fields) sum[k] += u[k];
    let changed = false;
    for (const k of fields) {
      // SDK result.usage is a run aggregate. It repairs missing stream data,
      // but must not be added on top of steps already billed at a tool pause.
      const total = Math.max(sum[k], this.resultFloor[k]);
      const delta = Math.max(0, total - this.runAccounted[k]);
      this.pending[k] += delta;
      this.runAccounted[k] += delta;
      changed ||= delta > 0;
    }
    return changed;
  }
  message(id, usage) {
    if (!usage || !id) return false;
    const before = this.messages.get(id) || zero();
    const next = normalized(usage);
    // Partial events and per-content-block assistant messages are cumulative
    // snapshots of the SAME API message. Repeated/late snapshots add nothing.
    this.messages.set(id, Object.fromEntries(fields.map(k => [k, Math.max(before[k], next[k])])));
    return this.account();
  }
  observe(msg) {
    if (msg.type === "stream_event") {
      const e = msg.event;
      if (e?.type === "message_start") {
        this.currentId = e.message?.id || "stream-" + (++this.sequence);
        return this.message(this.currentId, e.message?.usage);
      }
      if (e?.type === "message_delta") return this.message(this.currentId, e.usage);
    } else if (msg.type === "assistant") {
      return this.message(msg.message?.id || this.currentId || msg.uuid, msg.message?.usage);
    } else if (msg.type === "result" && msg.usage) {
      const u = normalized(msg.usage);
      for (const k of fields) this.resultFloor[k] = Math.max(this.resultFloor[k], u[k]);
      return this.account();
    }
    return false;
  }
  peek() {
    const { input, output, read, write } = this.pending;
    if (!input && !output && !read && !write) return null;
    const prompt = input + read + write;
    return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
      prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } };
  }
  acknowledge(u) {
    if (!u) return;
    const read = u.prompt_tokens_details.cached_tokens;
    const write = u.prompt_tokens_details.cache_write_tokens;
    const delivered = { input: u.prompt_tokens - read - write, output: u.completion_tokens, read, write };
    for (const k of fields) this.pending[k] = Math.max(0, this.pending[k] - delivered[k]);
  }
}
