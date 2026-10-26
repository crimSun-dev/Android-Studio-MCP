// Starts the server in --http mode and connects with the Streamable HTTP client using a path token.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const token = "test-token-123";
const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "--http", "39391"], {
  env: { ...process.env, ASMCP_TOKEN: token },
  stdio: ["ignore", "inherit", "pipe"],
});
await new Promise((r) => child.stderr.on("data", (d) => /listening/.test(d) && r()));
try {
  const bad = await fetch("http://127.0.0.1:39391/mcp/wrong", { method: "POST", body: "{}" });
  console.log("wrong token ->", bad.status);
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:39391/mcp/${token}`)));
  const { tools } = await client.listTools();
  console.log(`http: ${tools.length} tools`);
  const res = await client.callTool({ name: "devices_list", arguments: {} });
  console.log(res.content[0].text.slice(0, 200));
  await client.close();
} finally {
  child.kill();
}
