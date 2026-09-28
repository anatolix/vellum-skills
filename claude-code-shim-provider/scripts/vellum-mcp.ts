#!/usr/bin/env bun
// vellum-mcp: stdio MCP server that exposes Vellum's registered tools to a
// Claude Code process. Tools run in-process through Vellum's standalone runner
// (same path as `assistant tools run`): low-risk tools execute, anything that
// would need guardian approval is auto-denied. No approval bypass here.
//
// Env: VELLUM_WORKSPACE_DIR / VELLUM_DATA_DIR as for the assistant CLI.
//      VELLUM_MCP_INCLUDE  comma list — expose only these tools (optional).
//      VELLUM_MCP_EXCLUDE  comma list — hide these (default: UI-only tools).
//      VELLUM_MCP_TRUST    "unknown" (default: approval-gated tools denied) or
//                          "guardian" (full access, NO approval prompts at all).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const V = process.env.VELLUM_SRC || "/home/vellum/.bun/install/global/node_modules/@vellumai/assistant/src";
const reg = await import(`${V}/tools/registry.ts`);
const { ToolExecutor } = await import(`${V}/tools/executor.ts`);
const { PermissionPrompter } = await import(`${V}/permissions/prompter.ts`);
const cfgLoader = await import(`${V}/config/loader.ts`);
// Per-process override of timeouts.toolExecutionTimeoutSec (seconds). Does not touch config.json;
// getConfig() hands back its cached object by reference, so we re-stamp it before every call.
const TOOL_TIMEOUT_SEC = Number(process.env.VELLUM_MCP_TOOL_TIMEOUT_SEC) || 0;
function applyTimeoutOverride() {
  if (TOOL_TIMEOUT_SEC > 0) cfgLoader.getConfig().timeouts.toolExecutionTimeoutSec = TOOL_TIMEOUT_SEC;
}
const TRUST = process.env.VELLUM_MCP_TRUST === "guardian" ? "guardian" : "unknown";
const WORKDIR = process.env.VELLUM_WORKSPACE_DIR || process.cwd();
const executor = new ToolExecutor(new PermissionPrompter(() => {}));
async function runTool(name: string, input: Record<string, unknown>) {
  applyTimeoutOverride();
  return executor.execute(name, input, {
    conversationId: `mcp-${TRUST}`, workingDir: WORKDIR, requestId: crypto.randomUUID(),
    isInteractive: false, trustClass: TRUST,
  } as any);
}

const DEFAULT_EXCLUDE = "ask_question,ui_show,ui_update,ui_dismiss,file_upload,watch_retro_report,channel_setup,voice_picker";
const include = (process.env.VELLUM_MCP_INCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean);
const exclude = new Set((process.env.VELLUM_MCP_EXCLUDE ?? DEFAULT_EXCLUDE).split(",").map((s) => s.trim()).filter(Boolean));

await reg.initializeTools();
const tools = reg.getEnabledTools().filter((t: any) =>
  !exclude.has(t.name) && (!include.length || include.includes(t.name)));
console.error(`[vellum-mcp] exposing ${tools.length} tools, trust=${TRUST}, toolTimeout=${TOOL_TIMEOUT_SEC || "config"}s`);

const server = new Server({ name: "vellum", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t: any) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.input_schema || { type: "object", properties: {} },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments || {}) as Record<string, unknown>;
  console.error(`[vellum-mcp] call ${name}`);
  try {
    const r = await runTool(name, args);
    return { content: [{ type: "text", text: r.content ?? "" }], isError: !!r.isError };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
