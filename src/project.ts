import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SETTINGS_FILES = ["settings.gradle.kts", "settings.gradle"];
const BUILD_FILES = ["build.gradle.kts", "build.gradle"];

export function isGradleRoot(dir: string): boolean {
  return SETTINGS_FILES.some((f) => existsSync(path.join(dir, f)));
}

/** Resolve the Android project: explicit arg, then ANDROID_PROJECT_DIR, then the server's cwd (walking up). */
export function resolveProject(projectDir?: string): string {
  const explicit = projectDir ?? process.env.ANDROID_PROJECT_DIR;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!isGradleRoot(abs)) throw new Error(`${abs} is not a Gradle project root (no settings.gradle[.kts]).`);
    return abs;
  }
  let dir = process.cwd();
  for (;;) {
    if (isGradleRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "No Android project found. Pass projectDir, set ANDROID_PROJECT_DIR in the MCP server env, or start the server inside the project.",
  );
}

export function gradleWrapper(root: string): string {
  const name = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const p = path.join(root, name);
  if (!existsSync(p)) throw new Error(`No Gradle wrapper (${name}) in ${root}.`);
  return p;
}

function readFirst(dir: string, names: string[]): { file: string; text: string } | undefined {
  for (const n of names) {
    const file = path.join(dir, n);
    if (existsSync(file)) return { file, text: readFileSync(file, "utf8") };
  }
}

/** Module paths from include(":app", ":feature:home") / include ':app' in the settings script. */
export function listModules(root: string): string[] {
  const settings = readFirst(root, SETTINGS_FILES);
  if (!settings) return [];
  const mods = new Set<string>();
  // \b keeps includeBuild / includeGroupByRegex (repository filters) from matching.
  for (const m of settings.text.matchAll(/^\s*include\b\s*\(?([^)\n]+)\)?/gm)) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) mods.add(q[1].startsWith(":") ? q[1] : `:${q[1]}`);
  }
  return [...mods];
}

export const moduleDir = (root: string, mod: string) => path.join(root, ...mod.split(":").filter(Boolean));

function grab(text: string, key: string): string | undefined {
  // Matches `minSdk = 24`, `minSdk 24`, `minSdkVersion 24`, `applicationId = "x"`, `targetSdk { version = release(36) }`.
  const assign = new RegExp(`\\b${key}\\b[ \\t]*(?:=[ \\t]*|[ \\t]+)(?:release\\()?["']?([\\w.\\-]+)`, "m");
  const block = new RegExp(`\\b${key}\\s*\\{[^}]*?\\bversion\\s*=\\s*(?:release\\()?["']?([\\w.\\-]+)`, "m");
  return text.match(assign)?.[1] ?? text.match(block)?.[1];
}

export interface ModuleInfo {
  path: string;
  dir: string;
  buildFile?: string;
  type: "application" | "library" | "other";
  namespace?: string;
  applicationId?: string;
  compileSdk?: string;
  minSdk?: string;
  targetSdk?: string;
  launcherActivities: string[];
}

export function moduleInfo(root: string, mod: string): ModuleInfo {
  const dir = moduleDir(root, mod);
  const build = readFirst(dir, BUILD_FILES);
  const text = build?.text ?? "";
  const type = /com\.android\.application|android\.application\b/.test(text)
    ? "application"
    : /com\.android\.library|android\.library\b/.test(text)
      ? "library"
      : "other";
  const info: ModuleInfo = {
    path: mod,
    dir,
    buildFile: build?.file,
    type,
    namespace: grab(text, "namespace"),
    applicationId: grab(text, "applicationId"),
    compileSdk: grab(text, "compileSdk") ?? grab(text, "compileSdkVersion"),
    minSdk: grab(text, "minSdk") ?? grab(text, "minSdkVersion"),
    targetSdk: grab(text, "targetSdk") ?? grab(text, "targetSdkVersion"),
    launcherActivities: [],
  };
  const manifest = path.join(dir, "src", "main", "AndroidManifest.xml");
  if (existsSync(manifest)) info.launcherActivities = launcherActivities(readFileSync(manifest, "utf8"), info.namespace);
  return info;
}

function launcherActivities(xml: string, namespace?: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(activity|activity-alias)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    if (!/android\.intent\.category\.LAUNCHER/.test(m[3])) continue;
    const name = m[2].match(/android:name\s*=\s*"([^"]+)"/)?.[1];
    if (name) out.push(name.startsWith(".") && namespace ? namespace + name : name);
  }
  return out;
}

/** All APKs under a module's build outputs, newest first. */
export function findApks(dir: string): { file: string; mtime: number }[] {
  const root = path.join(dir, "build", "outputs", "apk");
  const found: { file: string; mtime: number }[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".apk")) found.push({ file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Recursively collect files matching a predicate (bounded depth to stay fast on big trees). */
export function collectFiles(dir: string, pred: (name: string) => boolean, depth = 6): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (level > depth || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, level + 1);
      else if (pred(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}
