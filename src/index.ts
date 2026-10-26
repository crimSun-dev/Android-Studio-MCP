#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { registerDeviceTools } from "./tools/device.js";
import { registerEmulatorTools } from "./tools/emulator.js";
import { registerGradleTools } from "./tools/gradle.js";
import { registerIdeTools } from "./tools/ide.js";
import { registerProjectTools } from "./tools/project.js";

const VERSION = "0.1.0";

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "android-studio-mcp", version: VERSION },
    {
      instructions:
        "Android development tools: Gradle builds/tests/lint for the project, adb device control (install, launch, logcat, screenshots, UI hierarchy, input), and emulator management. " +
        "Start with `environment` or `project_info`. Long operations (build, run_app, gradle_run, emulator_start) return a job: if status is 'running', poll `job_status` with the id. " +
        "When Android Studio is open with the bridge plugin, `ide_*` tools see live editor state: `ide_read_file` returns unsaved edits and `ide_problems` returns IDE analysis without a Gradle build. " +
        "To verify UI, use `screenshot` and `ui_dump`, then `input` with coordinates from ui_dump. After a crash, read `logcat` with crashesOnly.",
    },
  );
  registerProjectTools(server);
  registerGradleTools(server);
  registerDeviceTools(server);
  registerEmulatorTools(server);
  registerIdeTools(server);
  return server;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Streamable HTTP mode, for clients that only speak remote MCP (ChatGPT connectors, web IDEs).
 * Every request must carry the token, either as `Authorization: Bearer <token>` or in the path `/mcp/<token>`
 * (ChatGPT's connector UI can't set headers). Binds to localhost unless --host says otherwise.
 */
async function serveHttp(port: number, host: string) {
  const token = process.env.ASMCP_TOKEN || randomBytes(24).toString("base64url");
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathToken = url.pathname.match(/^\/mcp\/([^/]+)\/?$/)?.[1];
      const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (url.pathname !== "/mcp" && !pathToken) {
        res.writeHead(404).end();
        return;
      }
      if (!sameSecret(pathToken ?? bearer ?? "", token)) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid token" }));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first" }, id: null }),
          );
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, t),
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await buildServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("http error:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  http.listen(port, host, () => {
    console.error(`android-studio-mcp ${VERSION} listening on http://${host}:${port}/mcp`);
    console.error(`  header auth : Authorization: Bearer ${token}`);
    console.error(`  path auth   : http://${host}:${port}/mcp/${token}`);
    if (!process.env.ASMCP_TOKEN) console.error("  (random token; set ASMCP_TOKEN to keep it stable across restarts)");
  });
}

const httpFlag = flag("--http");
if (httpFlag !== undefined) {
  await serveHttp(Number(httpFlag || process.env.ASMCP_PORT || 3939), flag("--host") || "127.0.0.1");
} else {
  await buildServer().connect(new StdioServerTransport());
  // stdout is the protocol channel; diagnostics go to stderr only.
  console.error(`android-studio-mcp ${VERSION} ready on stdio`);
}
