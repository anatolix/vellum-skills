// Times one Vellum tool call through the vellum-mcp.ts bridge, bypassing any wrapper.
// Usage: MCP_SERVERS_FILE=/path/mcp_servers.json bun run mcp-time.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const cfg = JSON.parse(await Bun.file(process.env.MCP_SERVERS_FILE || `${process.env.HOME}/richard-shim/mcp_servers.json`).text()).mcpServers.vellum;
const t = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env, VELLUM_MCP_TRUST: "guardian", VELLUM_MCP_TOOL_TIMEOUT_SEC: "300" }, stderr: "pipe" });
t.stderr?.on("data", (d: Buffer) => process.stdout.write("[srv] " + d.toString()));
const c = new Client({ name: "t", version: "0" });
await c.connect(t);
const t0 = Date.now();
const r = await c.callTool({ name: "recall", arguments: { query: "claude-shim warm pool", depth: "fast" } }, undefined, { timeout: 400000 });
console.log("ms", Date.now() - t0);
console.log(JSON.stringify(r).slice(0, 600));
await c.close();
