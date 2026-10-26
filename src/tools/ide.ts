import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { callBridge, listBridges } from "../bridge.js";
import { json, safe, text } from "../util.js";

const project = z.string().optional().describe("Open project name or base path. Defaults to the project containing `path`, else the active one.");

/** Tools backed by the Android Studio plugin: live IDE state rather than files on disk. */
export function registerIdeTools(server: McpServer) {
  server.registerTool(
    "ide_status",
    {
      title: "Android Studio status",
      description: "Whether Android Studio (with the bridge plugin) is running, its version, and its open projects and indexing state.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      if (!listBridges().length) return json({ running: false, hint: "Start Android Studio with the Android Studio MCP Bridge plugin installed." });
      return json({ running: true, ...(await callBridge<object>("status")) });
    }),
  );

  server.registerTool(
    "ide_editors",
    {
      title: "Open editors",
      description: "Files open in Android Studio, which have unsaved changes, and the active file with caret position and selection.",
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => json(await callBridge("editors", a))),
  );

  server.registerTool(
    "ide_read_file",
    {
      title: "Read editor buffer",
      description:
        "Read a file as Android Studio currently has it, including unsaved edits. Prefer this over reading from disk when the user is editing in the IDE.",
      inputSchema: {
        path: z.string().describe("Absolute file path"),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const r = await callBridge<{ path: string; modified: boolean; lineCount: number; startLine: number; text: string }>("document", {
        ...a,
        path: path.resolve(a.path),
      });
      return text(`${r.path} (${r.lineCount} lines${r.modified ? ", UNSAVED CHANGES" : ""}, from line ${r.startLine})\n\n${r.text}`);
    }),
  );

  server.registerTool(
    "ide_problems",
    {
      title: "IDE problems",
      description:
        "Errors and warnings from Android Studio's live analysis of a file (Kotlin/Java compiler checks, Android Lint, inspections), without running Gradle. Opens the file in the IDE if needed.",
      inputSchema: {
        path: z.string().describe("Absolute file path"),
        minSeverity: z.enum(["error", "warning", "weak_warning"]).default("warning"),
        waitSec: z.number().int().min(0).max(60).default(8).describe("How long to wait for analysis to finish"),
        project,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => json(await callBridge("problems", { ...a, path: path.resolve(a.path) }, (a.waitSec + 25) * 1000))),
  );

  server.registerTool(
    "ide_open",
    {
      title: "Open in editor",
      description: "Open a file at a line/column in the running Android Studio and bring its window to the front.",
      inputSchema: {
        path: z.string(),
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional(),
        project,
      },
    },
    safe(async (a) => json(await callBridge("open", { ...a, path: path.resolve(a.path) }))),
  );

  server.registerTool(
    "ide_save_all",
    {
      title: "Save all",
      description: "Save all unsaved editor buffers to disk (build and run_app do this automatically when Studio is running).",
    },
    safe(async () => json(await callBridge("save_all"))),
  );

  server.registerTool(
    "ide_actions",
    {
      title: "Search IDE actions",
      description: "Search Android Studio's action ids by id or menu text (e.g. 'sync', 'reformat', 'rebuild').",
      inputSchema: { query: z.string().default(""), limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => json(await callBridge("actions", a))),
  );

  server.registerTool(
    "ide_action",
    {
      title: "Run IDE action",
      description:
        "Invoke an Android Studio action by id, as if chosen from the menu. Useful ids: Android.SyncProject (Gradle sync), ReformatCode, OptimizeImports, " +
        "MakeGradleProject (Build › Make), CompileDirty, Android.RunAndroidLint. Editor actions apply to the active editor; use ide_open first.",
      inputSchema: { id: z.string().min(1), project },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => json(await callBridge("action", a))),
  );

  server.registerTool(
    "ide_run_configurations",
    {
      title: "Run configurations",
      description: "List the project's run/debug configurations and which one is selected.",
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => json(await callBridge("run_configurations", a))),
  );

  server.registerTool(
    "ide_run",
    {
      title: "Run configuration",
      description:
        "Run or debug a run configuration in Android Studio, like its toolbar buttons (deploys to the IDE's selected device). Defaults to the selected configuration.",
      inputSchema: { name: z.string().optional(), debug: z.boolean().default(false), project },
    },
    safe(async (a) => json(await callBridge("run", a))),
  );

  server.registerTool(
    "ide_find_files",
    {
      title: "Find files",
      description: "Find project files by name using the IDE index: exact name ('MainActivity.kt') or glob ('*ViewModel.kt').",
      inputSchema: { name: z.string().min(1), limit: z.number().int().min(1).max(1000).default(100), project },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => json(await callBridge("find_files", a))),
  );
}
