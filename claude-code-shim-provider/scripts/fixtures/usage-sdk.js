// Test-only SDK: exercises the real server/Cli pump/MCP attach, no inference.
import { mock } from "bun:test";
const dummy = { optional() { return this; }, describe() { return this; }, int() { return this; } };
mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => dummy }) }));
const usage = (input, read, write, output) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });
const cold = usage(1000, 0, 500, 50), warm = usage(20, 1500, 100, 30);
const aggregate = usage(1020, 1500, 600, 80);
const stream = event => ({ type: "stream_event", event });
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name, _description, _shape, handler) => ({ name, handler }),
  createSdkMcpServer: x => x,
  query: ({ prompt, options }) => {
    let stopped = false;
    const gen = (async function* () {
      for await (const _input of prompt) {
        if (stopped) return;
        yield { type: "system", subtype: "init", session_id: "usage-test-session", tools: ["mcp__vellum__echo"] };
        if (process.env.SHIM_TEST_USAGE_MODE === "internal") {
          for (const [id, u] of [["cold", cold], ["warm", warm]]) {
            yield stream({ type: "message_start", message: { id, usage: { ...u, output_tokens: 1 } } });
            yield stream({ type: "message_delta", usage: { output_tokens: u.output_tokens } });
            yield { type: "assistant", uuid: id, message: { id, model: "test-sonnet", usage: u, content: [{ type: "text", text: id }] } };
            yield stream({ type: "message_stop" });
          }
          yield { type: "result", subtype: "success", session_id: "usage-test-session", usage: aggregate };
          continue;
        }
        yield stream({ type: "message_start", message: { id: "cold", usage: { ...cold, output_tokens: 1 } } });
        yield stream({ type: "content_block_start", content_block: { type: "tool_use" } });
        const toolResult = options.mcpServers.vellum.tools[0].handler({}, { _meta: { "claudecode/toolUseId": "toolu-test-1" } });
        const block = { type: "tool_use", id: "toolu-test-1", name: "mcp__vellum__echo", input: {} };
        if (process.env.SHIM_TEST_USAGE_MODE !== "late") yield stream({ type: "message_delta", usage: { output_tokens: 50 } });
        yield { type: "assistant", uuid: "cold-block", message: { id: "cold", model: "test-sonnet", usage: process.env.SHIM_TEST_USAGE_MODE === "late" ? { ...cold, output_tokens: 1 } : cold, content: [block] } };
        yield stream({ type: "message_stop" });
        if (process.env.SHIM_TEST_USAGE_MODE === "late") {
          await Bun.sleep(600);
          yield stream({ type: "message_delta", usage: { output_tokens: 50 } });
        }
        await toolResult;
        yield stream({ type: "message_start", message: { id: "warm", usage: { ...warm, output_tokens: 1 } } });
        yield stream({ type: "content_block_delta", delta: { type: "text_delta", text: "done" } });
        yield stream({ type: "message_delta", usage: { output_tokens: 30 } });
        yield { type: "assistant", uuid: "warm-block", message: { id: "warm", model: "test-sonnet", usage: warm, content: [{ type: "text", text: "done" }] } };
        yield { type: "assistant", uuid: "warm-duplicate", message: { id: "warm", model: "test-sonnet", usage: warm, content: [{ type: "text", text: "" }] } };
        yield stream({ type: "message_stop" });
        yield { type: "result", subtype: "success", session_id: "usage-test-session", usage: aggregate, total_cost_usd: 0.01 };
      }
    })();
    gen.close = () => { stopped = true; };
    gen.setModel = async () => {};
    gen.setMcpServers = async () => ({});
    gen.applyFlagSettings = async () => {};
    gen.getContextUsage = async () => null;
    return gen;
  },
}));
await import(process.argv[2]);
