import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { listBridges } from "./bridge.js";

/*
 * Toolchain discovery. Nothing here is specific to one machine: explicit env vars win, then everything that
 * Android Studio itself records about where it and the SDK live, then the standard install locations.
 */

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const exe = (name: string) => (isWindows ? `${name}.exe` : name);
const home = homedir();

function memo<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

const isDir = (p: string | undefined): p is string => {
  try {
    return !!p && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Directories on PATH containing the given executable. */
function onPath(name: string): string[] {
  const exts = isWindows ? ["", ".exe", ".bat", ".cmd"] : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => exts.some((e) => existsSync(path.join(dir, name + e))));
}

/** Read a value under HKLM/HKCU\SOFTWARE\<key> (Windows installer records). */
function registryValue(key: string, value: string): string[] {
  if (!isWindows) return [];
  const out: string[] = [];
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const text = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\${key}`, "/v", value], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const m = text.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
      if (m?.[1].trim()) out.push(m[1].trim());
    } catch {
      /* key not present */
    }
  }
  return out;
}

/** Android Studio's per-version config dirs (newest first), e.g. %APPDATA%\Google\AndroidStudio2026.2.1. */
export const studioConfigDirs = memo((): string[] => {
  const base = isWindows
    ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Google")
    : isMac
      ? path.join(home, "Library", "Application Support", "Google")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Google");
  if (!isDir(base)) return [];
  return readdirSync(base)
    .filter((d) => /^AndroidStudio/.test(d))
    .map((d) => path.join(base, d))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
});

// ---- Android SDK -------------------------------------------------------------------------------

/** Read sdk.dir from a project's local.properties (Studio writes it with escaped colons/backslashes). */
function sdkFromLocalProperties(projectDir: string | undefined): string | undefined {
  if (!projectDir) return;
  const file = path.join(projectDir, "local.properties");
  if (!existsSync(file)) return;
  const m = readFileSync(file, "utf8").match(/^\s*sdk\.dir\s*=\s*(.+)$/m);
  if (!m) return;
  return m[1].trim().replace(/\\(.)/g, "$1");
}

/** SDKs registered in Studio's settings (options/jdk.table.xml entries of type "Android SDK"). */
const sdksFromStudioConfig = memo((): string[] => {
  const out: string[] = [];
  for (const dir of studioConfigDirs()) {
    const file = path.join(dir, "options", "jdk.table.xml");
    if (!existsSync(file)) continue;
    for (const jdk of readFileSync(file, "utf8").split("<jdk ").slice(1)) {
      if (!/<type value="Android SDK"/.test(jdk)) continue;
      const p = jdk.match(/<homePath value="([^"]+)"/)?.[1];
      if (p) out.push(p.replace("$USER_HOME$", home));
    }
  }
  return out;
});

function defaultSdkLocations(): string[] {
  if (isWindows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Android", "Sdk"), "C:\\Android\\Sdk"];
  }
  if (isMac) return [path.join(home, "Library", "Android", "sdk")];
  return [path.join(home, "Android", "Sdk"), "/opt/android-sdk", "/usr/lib/android-sdk"];
}

export function sdkCandidates(projectDir?: string): { path: string; source: string }[] {
  const list: { path: string | undefined; source: string }[] = [
    { path: process.env.ANDROID_SDK_ROOT, source: "ANDROID_SDK_ROOT" },
    { path: process.env.ANDROID_HOME, source: "ANDROID_HOME" },
    { path: sdkFromLocalProperties(projectDir), source: "local.properties" },
    ...sdksFromStudioConfig().map((p) => ({ path: p, source: "Android Studio settings" })),
    ...registryValue("Android Studio", "SdkPath").map((p) => ({ path: p, source: "registry" })),
    ...onPath("adb").map((d) => ({ path: path.dirname(d), source: "adb on PATH" })),
    ...defaultSdkLocations().map((p) => ({ path: p, source: "default location" })),
  ];
  return list.filter((c): c is { path: string; source: string } => isDir(c.path) && existsSync(path.join(c.path, "platform-tools")));
}

export function findSdk(projectDir?: string): string | undefined {
  return sdkCandidates(projectDir)[0]?.path;
}

export function requireSdk(projectDir?: string): string {
  const sdk = findSdk(projectDir);
  if (!sdk) {
    throw new Error(
      "Android SDK not found. Install it from Android Studio (SDK Manager), or set ANDROID_SDK_ROOT in the MCP server's env.",
    );
  }
  return sdk;
}

export const adbPath = (sdk: string) => path.join(sdk, "platform-tools", exe("adb"));
export const emulatorPath = (sdk: string) => path.join(sdk, "emulator", exe("emulator"));

/** Locate the newest cmdline-tools binary (sdkmanager / avdmanager), if installed. */
export function cmdlineToolPath(sdk: string, tool: "sdkmanager" | "avdmanager"): string | undefined {
  const root = path.join(sdk, "cmdline-tools");
  if (!existsSync(root)) return;
  const dirs = readdirSync(root).sort((a, b) => (a === "latest" ? -1 : b === "latest" ? 1 : b.localeCompare(a)));
  for (const d of dirs) {
    const p = path.join(root, d, "bin", isWindows ? `${tool}.bat` : tool);
    if (existsSync(p)) return p;
  }
}

// ---- Android Studio ----------------------------------------------------------------------------

// JetBrains Toolbox installs: <toolbox>/apps/AndroidStudio/ch-N/<build> (older) or <toolbox>/apps/android-studio (newer).
function toolboxStudios(): string[] {
  const roots = isWindows
    ? [path.join(process.env.LOCALAPPDATA ?? "", "JetBrains", "Toolbox", "apps"), path.join(process.env.LOCALAPPDATA ?? "", "Programs")]
    : isMac
      ? [path.join(home, "Library", "Application Support", "JetBrains", "Toolbox", "apps"), path.join(home, "Applications")]
      : [path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps")];
  const out: string[] = [];
  for (const root of roots.filter(isDir)) {
    for (const app of readdirSync(root).filter((d) => /android.?studio/i.test(d))) {
      const appDir = path.join(root, app);
      out.push(isMac && app.endsWith(".app") ? path.join(appDir, "Contents") : appDir);
      for (const ch of readdirSync(appDir).filter((d) => d.startsWith("ch-"))) {
        const builds = readdirSync(path.join(appDir, ch)).filter((b) => /^\d/.test(b)).sort().reverse();
        out.push(...builds.map((b) => path.join(appDir, ch, b, ...(isMac ? ["Android Studio.app", "Contents"] : []))));
      }
    }
  }
  return out;
}

function defaultStudioLocations(): string[] {
  if (isWindows) {
    return [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Android Studio"),
      path.join(process.env.LOCALAPPDATA ?? "", "Android", "android-studio"),
    ];
  }
  if (isMac) return ["/Applications/Android Studio.app/Contents", path.join(home, "Applications", "Android Studio.app", "Contents")];
  return ["/opt/android-studio", "/usr/local/android-studio", path.join(home, "android-studio"), "/snap/android-studio/current", "/snap/android-studio/current/android-studio"];
}

/** Every place Android Studio might be, with where the hint came from. Only real installs are returned. */
export function studioCandidates(): { path: string; source: string }[] {
  const list: { path: string | undefined; source: string }[] = [
    { path: process.env.ANDROID_STUDIO_HOME, source: "ANDROID_STUDIO_HOME" },
    // A running Studio with the bridge plugin knows exactly where it is installed.
    ...listBridges().map((b) => ({ path: b.home, source: "running Android Studio" })),
    ...registryValue("Android Studio", "Path").map((p) => ({ path: p, source: "registry" })),
    ...onPath(isWindows ? "studio64" : "studio").map((d) => ({ path: path.dirname(d), source: "studio on PATH" })),
    ...toolboxStudios().map((p) => ({ path: p, source: "JetBrains Toolbox" })),
    ...defaultStudioLocations().map((p) => ({ path: p, source: "default location" })),
  ];
  const seen = new Set<string>();
  return list.filter((c): c is { path: string; source: string } => {
    if (!isDir(c.path) || !existsSync(path.join(c.path, "bin")) || !existsSync(path.join(c.path, isMac ? "Resources/product-info.json" : "product-info.json"))) {
      return false;
    }
    const key = path.resolve(c.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Android Studio install dir, used for its bundled JBR, the plugin build, and opening files in the IDE. */
export function findStudio(): string | undefined {
  return studioCandidates()[0]?.path;
}

export function studioLauncher(studio: string): string | undefined {
  if (isMac) {
    const mac = path.join(studio, "MacOS", "studio");
    if (existsSync(mac)) return mac;
  }
  const names = isWindows ? ["studio64.exe", "studio.bat"] : ["studio.sh", "studio"];
  return names.map((n) => path.join(studio, "bin", n)).find(existsSync);
}

export function studioJbr(studio: string | undefined): string | undefined {
  return studio ? [path.join(studio, "jbr"), path.join(studio, "Contents", "jbr")].find(isDir) : undefined;
}

/** Environment for Gradle: keep the user's JAVA_HOME, else fall back to Studio's bundled JBR. */
export function gradleEnv(sdk: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (sdk) {
    env.ANDROID_HOME ??= sdk;
    env.ANDROID_SDK_ROOT ??= sdk;
  }
  if (!env.JAVA_HOME) {
    const jbr = studioJbr(findStudio());
    if (jbr) env.JAVA_HOME = jbr;
  }
  return env;
}
