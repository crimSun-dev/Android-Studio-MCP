// Start a job-returning tool, then poll job_status until it finishes (what a client with short timeouts does).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const [tool, args = "{}"] = process.argv.slice(2);
const client = new Client({ name: "poll", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], env: { ...process.env }, stderr: "inherit" }));
const call = async (name, a) => JSON.parse((await client.callTool({ name, arguments: a }, undefined, { timeout: 600_000 })).content[0].text);
let job = await call(tool, JSON.parse(args));
while (job.status === "running") {
  console.log(`[${job.elapsedSec}s] running… ${job.logTail.trim().split("\n").pop()}`);
  job = await call("job_status", { id: job.id, waitSec: 60, logChars: 3000 });
}
console.log(JSON.stringify(job, null, 2));
await client.close();
