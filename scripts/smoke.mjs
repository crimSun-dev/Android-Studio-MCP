// Spawns the built server over stdio and calls a few tools, like an MCP client would.
// Usage: node scripts/smoke.mjs [toolName '{"json":"args"}' ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

const argv = process.argv.slice(2);
const calls = argv.length
  ? argv.reduce((acc, a, i) => (i % 2 === 0 ? [...acc, [a, JSON.parse(argv[i + 1] ?? "{}")]] : acc), [])
  : [["environment", {}], ["project_info", {}], ["devices_list", {}], ["emulator_list", {}]];

for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const body = res.content.map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.mimeType} ${c.data?.length} b64 chars]`)).join("\n");
  console.log(`== ${name}${res.isError ? " (ERROR)" : ""}\n${body.slice(0, 4000)}\n`);
}
await client.close();
