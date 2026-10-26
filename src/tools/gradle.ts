import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { saveAllIfIdeRunning } from "../bridge.js";
import { findSdk, gradleEnv } from "../env.js";
import { killTree, run, tail } from "../exec.js";
import { describeJob, startJob, waitForJob, type JobContext } from "../jobs.js";
import { collectFiles, findApks, gradleWrapper, listModules, moduleDir, moduleInfo, resolveProject } from "../project.js";
import { adb, json, resolveSerial, safe, shell, shq } from "../util.js";

const projectDir = z.string().optional().describe("Android project root. Defaults to ANDROID_PROJECT_DIR or the server's cwd.");
const taskName = z.string().regex(/^[\w:.\-]+$/, "invalid Gradle task name");
const extraArg = z.string().regex(/^-{1,2}[\w.\-]+(=[\w.:\/\\\-,]*)?$/, "only -flag or --flag[=value] style args are allowed");

export interface Diagnostic {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

/** Pull compiler diagnostics (Kotlin, Java, AAPT, KSP/kapt) and Gradle's failure summary out of build output. */
export function parseBuildOutput(output: string): { diagnostics: Diagnostic[]; failure?: string } {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.column}|${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(d);
    }
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    // Kotlin 2.x: "e: file:///C:/x/A.kt:12:5 Unresolved reference 'foo'."
    if ((m = line.match(/^([ew]): (?:file:\/\/)?(.+?):(\d+):(\d+) (.+)$/))) {
      push({ severity: m[1] === "e" ? "error" : "warning", file: fileUrl(m[2]), line: +m[3], column: +m[4], message: m[5] });
    }
    // Kotlin 1.x: "e: C:\x\A.kt: (12, 5): message"
    else if ((m = line.match(/^([ew]): (.+?): \((\d+), (\d+)\): (.+)$/))) {
      push({ severity: m[1] === "e" ? "error" : "warning", file: m[2], line: +m[3], column: +m[4], message: m[5] });
    }
    // javac: "C:\x\A.java:12: error: message"
    else if ((m = line.match(/^(.+?\.java):(\d+): (error|warning): (.+)$/))) {
      push({ severity: m[3] as Diagnostic["severity"], file: m[1], line: +m[2], message: m[4] });
    }
    // AAPT2: "ERROR: C:\x\res\layout\a.xml:12: AAPT: error: message" or "...a.xml:12:5: AAPT: error:"
    else if ((m = line.match(/^(?:ERROR:\s*)?(.+?\.xml):(\d+)(?::(\d+))?: AAPT: (error|warning): (.+)$/i))) {
      push({ severity: m[4].toLowerCase() as Diagnostic["severity"], file: m[1], line: +m[2], column: m[3] ? +m[3] : undefined, message: m[5] });
    }
  }
  const failure = output.match(/\* What went wrong:\r?\n([\s\S]*?)(?:\r?\n\* Try:|\r?\n\* Exception is:|\r?\nBUILD FAILED|$)/)?.[1]?.trim();
  return { diagnostics, failure };
}

function fileUrl(p: string): string {
  // file:///C:/x → C:/x on Windows; file:///home/x → /home/x elsewhere.
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

async function runGradle(root: string, tasks: string[], args: string[], ctx: JobContext) {
  const wrapper = gradleWrapper(root);
  const saved = await saveAllIfIdeRunning();
  if (saved?.length) ctx.log(`Saved ${saved.length} unsaved file(s) in Android Studio first
`);
  const full = [...tasks, "--console=plain", ...args];
  ctx.log(`> ${path.basename(wrapper)} ${full.join(" ")}\n`);
  const res = await run(wrapper, full, {
    cwd: root,
    env: gradleEnv(findSdk(root)),
    timeoutMs: 60 * 60_000,
    onOutput: ctx.log,
    onSpawn: (pid) => ctx.onCancel(() => killTree(pid)),
  });
  const output = res.stdout + "\n" + res.stderr;
  const parsed = parseBuildOutput(output);
  const success = res.code === 0;
  const summary = {
    success,
    exitCode: res.code,
    durationSec: Math.round(res.durationMs / 1000),
    errors: parsed.diagnostics.filter((d) => d.severity === "error"),
    warningCount: parsed.diagnostics.filter((d) => d.severity === "warning").length,
    ...(parsed.failure ? { whatWentWrong: tail(parsed.failure, 6000) } : {}),
  };
  if (!success) throw Object.assign(new Error(parsed.failure?.split(/\r?\n/)[0] ?? `Gradle exited ${res.code}`), { summary });
  return summary;
}

/** Start Gradle as a job, wait a bit, and return the job description (result or progress). */
async function gradleJob(name: string, waitSec: number, work: (ctx: JobContext) => Promise<unknown>) {
  const job = startJob(name, async (ctx) => {
    try {
      return await work(ctx);
    } catch (err) {
      const summary = (err as { summary?: unknown }).summary;
      if (summary) ctx.log(`\n[summary] ${JSON.stringify(summary)}\n`);
      throw summary ? Object.assign(err as Error, { message: `${(err as Error).message}\n${JSON.stringify(summary, null, 2)}` }) : err;
    }
  });
  await waitForJob(job, waitSec * 1000);
  return json(describeJob(job, job.status === "running" ? 3000 : 4000));
}

const waitSec = z
  .number()
  .int()
  .min(0)
  .max(110)
  .default(50)
  .describe("Seconds to wait before returning. If the build is still running, poll with job_status.");

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function defaultAppModule(root: string): string {
  const app = listModules(root).find((m) => moduleInfo(root, m).type === "application");
  if (!app) throw new Error("No application module found; pass module.");
  return app;
}

interface TestCase {
  suite: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  timeSec: number;
  failure?: string;
}

function parseJUnitXml(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => m[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? "";
    const body = m[3] ?? "";
    const fail = body.match(/<(failure|error)\b[^>]*?(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/);
    cases.push({
      suite: attr("classname"),
      name: attr("name"),
      status: fail ? "failed" : /<skipped/.test(body) ? "skipped" : "passed",
      timeSec: Number(attr("time")) || 0,
      ...(fail ? { failure: tail((fail[2] ? fail[2] + "\n" : "") + fail[3].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"), 3000) } : {}),
    });
  }
  return cases;
}

export function registerGradleTools(server: McpServer) {
  server.registerTool(
    "gradle_tasks",
    {
      title: "List Gradle tasks",
      description: "List the Gradle tasks available in the project (or one module).",
      inputSchema: { projectDir, module: z.string().optional().describe("Module path such as :app"), all: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const task = a.module ? `${a.module}:tasks` : "tasks";
      const res = await run(gradleWrapper(root), [task, "--console=plain", ...(a.all ? ["--all"] : [])], {
        cwd: root,
        env: gradleEnv(findSdk(root)),
        timeoutMs: 10 * 60_000,
      });
      const lines = res.stdout.split(/\r?\n/).filter((l) => /^\w[\w:-]* - /.test(l) || /^[A-Z][\w ]+ tasks$/.test(l));
      return { content: [{ type: "text", text: lines.join("\n") || tail(res.stdout + res.stderr) }], isError: res.code !== 0 };
    }),
  );

  server.registerTool(
    "gradle_run",
    {
      title: "Run Gradle tasks",
      description:
        "Run Gradle tasks through the project's wrapper (e.g. ['assembleDebug'], [':app:testDebugUnitTest'], ['clean','build']). Returns parsed compiler errors. Runs as a job; poll with job_status if still running.",
      inputSchema: {
        projectDir,
        tasks: z.array(taskName).min(1),
        args: z.array(extraArg).default([]).describe("Extra flags, e.g. --offline, --stacktrace, -Pfoo=bar"),
        waitSec,
      },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      return gradleJob(`gradle ${a.tasks.join(" ")}`, a.waitSec, (ctx) => runGradle(root, a.tasks, a.args, ctx));
    }),
  );

  server.registerTool(
    "build",
    {
      title: "Build app",
      description: "Assemble an APK for a module and variant (default: the app module, debug). Returns compiler errors and the APK path.",
      inputSchema: {
        projectDir,
        module: z.string().optional().describe("Module path, e.g. :app. Defaults to the first application module."),
        variant: z.string().regex(/^\w+$/).default("debug").describe("Build variant, e.g. debug, release, freeDebug"),
        waitSec,
      },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const mod = a.module ?? defaultAppModule(root);
      const task = `${mod}:assemble${capitalize(a.variant)}`;
      return gradleJob(`build ${task}`, a.waitSec, async (ctx) => {
        const summary = await runGradle(root, [task], [], ctx);
        return { ...summary, apk: findApks(moduleDir(root, mod))[0]?.file };
      });
    }),
  );

  server.registerTool(
    "run_app",
    {
      title: "Build, install and launch",
      description:
        "The Android Studio 'Run' button: assemble the variant, install it on the device, and launch the launcher activity. Runs as a job.",
      inputSchema: {
        projectDir,
        module: z.string().optional(),
        variant: z.string().regex(/^\w+$/).default("debug"),
        serial: z.string().optional().describe("Target device; optional when exactly one is online"),
        waitSec,
      },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const mod = a.module ?? defaultAppModule(root);
      const serial = await resolveSerial(a.serial);
      const task = `${mod}:assemble${capitalize(a.variant)}`;
      return gradleJob(`run_app ${task} → ${serial}`, a.waitSec, async (ctx) => {
        const summary = await runGradle(root, [task], [], ctx);
        const apk = findApks(moduleDir(root, mod))[0]?.file;
        if (!apk) throw new Error("Build succeeded but no APK was found under build/outputs/apk.");
        ctx.log(`\n> adb install -r -t ${apk}\n`);
        const install = await adb(["install", "-r", "-t", apk], serial, 300_000);
        ctx.log(install.stdout);
        const info = moduleInfo(root, mod);
        const appId = await applicationIdFromApk(apk, info.applicationId ?? info.namespace);
        const resolved = await shell(serial, `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${appId}`);
        const component = resolved.trim().split(/\r?\n/).pop() ?? "";
        if (!component.includes("/")) throw new Error(`Installed, but no launcher activity found for ${appId}.`);
        ctx.log(`> am start -W -S -n ${component}\n`);
        const launch = await shell(serial, `am start -W -S -n ${shq(component)}`);
        ctx.log(launch);
        return { buildSec: summary.durationSec, apk, applicationId: appId, component, serial, launch: launch.trim() };
      });
    }),
  );

  server.registerTool(
    "test_results",
    {
      title: "Read test results",
      description:
        "Parse JUnit XML results from the last unit test (test*UnitTest) or instrumented test (connected*AndroidTest) run. Run tests with gradle_run first.",
      inputSchema: {
        projectDir,
        module: z.string().optional().describe("Limit to one module"),
        failedOnly: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const mods = a.module ? [a.module] : listModules(root);
      const cases: (TestCase & { module: string })[] = [];
      for (const mod of mods) {
        const build = path.join(moduleDir(root, mod), "build");
        const files = [
          ...collectFiles(path.join(build, "test-results"), (n) => n.startsWith("TEST-") && n.endsWith(".xml")),
          ...collectFiles(path.join(build, "outputs", "androidTest-results"), (n) => n.endsWith(".xml"), 8),
        ];
        for (const f of files) for (const c of parseJUnitXml(readFileSync(f, "utf8"))) cases.push({ module: mod, ...c });
      }
      const count = (s: TestCase["status"]) => cases.filter((c) => c.status === s).length;
      return json({
        total: cases.length,
        passed: count("passed"),
        failed: count("failed"),
        skipped: count("skipped"),
        tests: a.failedOnly ? cases.filter((c) => c.status === "failed") : cases,
      });
    }),
  );

  server.registerTool(
    "lint_results",
    {
      title: "Read Android Lint results",
      description: "Parse the Android Lint XML report (run gradle_run with lintDebug or lint first).",
      inputSchema: {
        projectDir,
        module: z.string().optional(),
        minSeverity: z.enum(["Information", "Warning", "Error", "Fatal"]).default("Warning"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const rank = ["Information", "Warning", "Error", "Fatal"];
      const mods = a.module ? [a.module] : listModules(root);
      const issues: unknown[] = [];
      const reports: string[] = [];
      for (const mod of mods) {
        const reportsDir = path.join(moduleDir(root, mod), "build", "reports");
        const files = collectFiles(reportsDir, (n) => /^lint-results.*\.xml$/.test(n), 1);
        const newest = files.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
        if (!newest) continue;
        reports.push(newest);
        const xml = readFileSync(newest, "utf8");
        for (const m of xml.matchAll(/<issue\b([\s\S]*?)>([\s\S]*?)<\/issue>/g)) {
          const at = (k: string, s = m[1]) => s.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
          const sev = at("severity") ?? "Warning";
          if (rank.indexOf(sev) < rank.indexOf(a.minSeverity)) continue;
          const loc = m[2].match(/<location\b([^>]*)\/?>/)?.[1] ?? "";
          issues.push({
            module: mod,
            id: at("id"),
            severity: sev,
            category: at("category"),
            message: at("message"),
            file: at("file", loc),
            line: at("line", loc) ? Number(at("line", loc)) : undefined,
          });
        }
      }
      if (!reports.length) throw new Error("No lint report found. Run gradle_run with tasks ['lintDebug'] first.");
      return json({ reports, count: issues.length, issues });
    }),
  );
}

/** Read the installed package name from the APK via aapt2 if available; fall back to the build script value. */
async function applicationIdFromApk(apk: string, fallback?: string): Promise<string> {
  const sdk = findSdk();
  if (sdk) {
    const btRoot = path.join(sdk, "build-tools");
    const versions = existsSync(btRoot) ? readdirSync(btRoot).sort().reverse() : [];
    for (const v of versions) {
      const aapt = path.join(btRoot, v, process.platform === "win32" ? "aapt2.exe" : "aapt2");
      if (!existsSync(aapt)) continue;
      const res = await run(aapt, ["dump", "packagename", apk], { timeoutMs: 30_000 });
      const name = res.stdout.trim();
      if (res.code === 0 && name) return name;
    }
  }
  if (fallback) return fallback;
  throw new Error("Could not determine the applicationId of the built APK.");
}

