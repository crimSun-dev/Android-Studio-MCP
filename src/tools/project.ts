import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { callBridge, listBridges } from "../bridge.js";
import { cmdlineToolPath, findSdk, findStudio, studioLauncher } from "../env.js";
import { run, spawnDetached, tail } from "../exec.js";
import { describeJob, getJob, listJobs, waitForJob } from "../jobs.js";
import { findApks, listModules, moduleDir, moduleInfo, resolveProject } from "../project.js";
import { fail, json, safe, text } from "../util.js";

const projectDir = z.string().optional().describe("Android project root. Defaults to ANDROID_PROJECT_DIR or the server's cwd.");

function readProps(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.\-]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function registerProjectTools(server: McpServer) {
  server.registerTool(
    "environment",
    {
      title: "Environment",
      description:
        "Report the Android toolchain this server sees: SDK path and installed packages, Android Studio install, JAVA_HOME, and the resolved project. Call this first when something isn't found.",
      inputSchema: { projectDir },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      let project: string | undefined;
      let projectError: string | undefined;
      try {
        project = await resolveProject(a.projectDir);
      } catch (e) {
        projectError = (e as Error).message;
      }
      const sdk = findSdk(project);
      const ls = (...p: string[]) => {
        const d = sdk && path.join(sdk, ...p);
        return d && existsSync(d) ? readdirSync(d) : [];
      };
      const studio = findStudio();
      let studioVersion: string | undefined;
      if (studio) {
        const build = [path.join(studio, "build.txt"), path.join(studio, "Resources", "build.txt")].find(existsSync);
        studioVersion = build && readFileSync(build, "utf8").trim();
      }
      return json({
        sdk: sdk ?? null,
        platformTools: sdk ? readProps(path.join(sdk, "platform-tools", "source.properties"))["Pkg.Revision"] : undefined,
        buildTools: ls("build-tools"),
        platforms: ls("platforms"),
        systemImages: ls("system-images").flatMap((api) => ls("system-images", api).flatMap((tag) => ls("system-images", api, tag).map((abi) => `${api};${tag};${abi}`))),
        emulator: sdk ? readProps(path.join(sdk, "emulator", "source.properties"))["Pkg.Revision"] ?? null : null,
        cmdlineTools: sdk ? (cmdlineToolPath(sdk, "sdkmanager") ?? "not installed (sdkmanager/avdmanager unavailable)") : null,
        androidStudio: studio ? { home: studio, build: studioVersion } : "not found (set ANDROID_STUDIO_HOME)",
        javaHome: process.env.JAVA_HOME ?? (studio ? `${path.join(studio, "jbr")} (Studio JBR fallback)` : null),
        project: project ?? null,
        ...(projectError ? { projectError } : {}),
        platform: `${process.platform} ${process.arch}, node ${process.version}`,
      });
    }),
  );

  server.registerTool(
    "project_info",
    {
      title: "Project info",
      description:
        "Summarize the Android project: modules, their type, namespace/applicationId, SDK levels, launcher activities, Gradle and AGP versions.",
      inputSchema: { projectDir },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const wrapper = readProps(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"));
      const gradleVersion = wrapper.distributionUrl?.match(/gradle-([\d.]+(?:-[\w.]+)?)-(?:bin|all)\.zip/)?.[1];
      const catalogFile = path.join(root, "gradle", "libs.versions.toml");
      const catalog = existsSync(catalogFile) ? readFileSync(catalogFile, "utf8") : "";
      const ver = (key: string) => catalog.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
      return json({
        root,
        gradle: gradleVersion,
        agp: ver("agp") ?? ver("androidGradlePlugin"),
        kotlin: ver("kotlin"),
        modules: listModules(root).map((m) => {
          const { dir: _dir, ...info } = moduleInfo(root, m);
          return info;
        }),
      });
    }),
  );

  server.registerTool(
    "project_apks",
    {
      title: "Built APKs",
      description: "List APKs produced by previous builds, newest first.",
      inputSchema: { projectDir, module: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const root = await resolveProject(a.projectDir);
      const mods = a.module ? [a.module] : listModules(root);
      return json(
        mods.flatMap((m) =>
          findApks(moduleDir(root, m)).map((f) => ({ module: m, file: f.file, built: new Date(f.mtime).toISOString() })),
        ),
      );
    }),
  );

  server.registerTool(
    "studio_open",
    {
      title: "Open in Android Studio",
      description:
        "Open a project, or a file at a line, in Android Studio (reuses the running IDE window if one is open). Handy for handing off to the human.",
      inputSchema: {
        path: z.string().describe("File or project directory to open"),
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional(),
      },
    },
    safe(async (a) => {
      if (listBridges().length) {
        await callBridge("open", { path: path.resolve(a.path), line: a.line, column: a.column });
        return text(`Opened ${path.resolve(a.path)}${a.line ? `:${a.line}` : ""} in the running Android Studio`);
      }
      const studio = findStudio();
      const launcher = studio && studioLauncher(studio);
      if (!launcher) return fail("Android Studio not found. Set ANDROID_STUDIO_HOME to its install directory.");
      const target = path.resolve(a.path);
      if (!existsSync(target)) return fail(`No such file: ${target}`);
      const args = [
        ...(a.line ? ["--line", String(a.line)] : []),
        ...(a.column ? ["--column", String(a.column)] : []),
        target,
      ];
      spawnDetached(launcher, args);
      return text(`Opened ${target}${a.line ? `:${a.line}` : ""} in Android Studio`);
    }),
  );

  server.registerTool(
    "sdk_manager",
    {
      title: "SDK manager",
      description:
        "List installed/available SDK packages or install packages (e.g. 'platforms;android-36', 'system-images;android-36;google_apis;x86_64'). Requires the SDK Command-line Tools package.",
      inputSchema: {
        action: z.enum(["list_installed", "list_available", "install"]),
        packages: z.array(z.string().regex(/^[\w.;\-]+$/)).default([]),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const sdk = findSdk();
      const sdkmanager = sdk && cmdlineToolPath(sdk, "sdkmanager");
      if (!sdkmanager) {
        return fail(
          "sdkmanager not found. In Android Studio: Settings → Languages & Frameworks → Android SDK → SDK Tools → check 'Android SDK Command-line Tools (latest)'.",
        );
      }
      const args = [`--sdk_root=${sdk}`];
      if (a.action === "install") {
        if (!a.packages.length) return fail("install needs packages");
        args.push("--install", ...a.packages);
      } else args.push("--list", ...(a.action === "list_installed" ? ["--installed"] : []));
      // "y" answers license prompts for packages the user explicitly asked to install.
      const res = await run(sdkmanager, args, { timeoutMs: 30 * 60_000, input: "y\n".repeat(20) });
      return { content: [{ type: "text", text: tail(res.stdout + res.stderr) }], isError: res.code !== 0 };
    }),
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description: "Check a background job (build, run_app, emulator_start). Optionally wait for it to finish. Omit id to list all jobs.",
      inputSchema: {
        id: z.string().optional(),
        waitSec: z.number().int().min(0).max(110).default(0).describe("Wait up to this long for the job to finish"),
        logChars: z.number().int().min(0).max(100_000).default(6000).describe("How much of the log tail to include"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      if (!a.id) return json(listJobs().map((j) => ({ ...describeJob(j, 0), logTail: undefined })));
      const job = getJob(a.id);
      if (!job) return fail(`No job ${a.id}`);
      await waitForJob(job, a.waitSec * 1000);
      return json(describeJob(job, a.logChars));
    }),
  );

  server.registerTool(
    "job_cancel",
    {
      title: "Cancel job",
      description: "Cancel a running background job.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      const job = getJob(a.id);
      if (!job) return fail(`No job ${a.id}`);
      job.cancel?.();
      return json(describeJob(job, 1000));
    }),
  );
}
