import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const exe = (name: string) => (isWindows ? `${name}.exe` : name);

/** Read sdk.dir from a project's local.properties (Studio writes it with escaped colons/backslashes). */
function sdkFromLocalProperties(projectDir: string | undefined): string | undefined {
  if (!projectDir) return;
  const file = path.join(projectDir, "local.properties");
  if (!existsSync(file)) return;
  const m = readFileSync(file, "utf8").match(/^\s*sdk\.dir\s*=\s*(.+)$/m);
  if (!m) return;
  return m[1].trim().replace(/\\(.)/g, "$1");
}

function defaultSdkLocations(): string[] {
  const home = homedir();
  if (isWindows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Android", "Sdk")];
  }
  if (process.platform === "darwin") return [path.join(home, "Library", "Android", "sdk")];
  return [path.join(home, "Android", "Sdk")];
}

export function findSdk(projectDir?: string): string | undefined {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    sdkFromLocalProperties(projectDir),
    ...defaultSdkLocations(),
  ];
  return candidates.find((p): p is string => !!p && existsSync(path.join(p, "platform-tools")));
}

export function requireSdk(projectDir?: string): string {
  const sdk = findSdk(projectDir);
  if (!sdk) {
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT (or ANDROID_HOME) in the MCP server's env, " +
        "or point projectDir at a project whose local.properties has sdk.dir.",
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

/** Android Studio install dir, used for its bundled JBR and for opening files in the IDE. */
export function findStudio(): string | undefined {
  const candidates: string[] = [];
  if (process.env.ANDROID_STUDIO_HOME) candidates.push(process.env.ANDROID_STUDIO_HOME);
  if (isWindows) {
    candidates.push(
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Android Studio"),
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Android Studio.app/Contents");
  } else {
    candidates.push("/opt/android-studio", path.join(homedir(), "android-studio"));
  }
  return candidates.find((p) => p && existsSync(path.join(p, "bin")));
}

export function studioLauncher(studio: string): string | undefined {
  const names = isWindows ? ["studio64.exe", "studio.bat"] : process.platform === "darwin" ? ["studio"] : ["studio.sh", "studio"];
  if (process.platform === "darwin") {
    const mac = path.join(studio, "MacOS", "studio");
    if (existsSync(mac)) return mac;
  }
  return names.map((n) => path.join(studio, "bin", n)).find(existsSync);
}

/** Environment for Gradle: keep the user's JAVA_HOME, else fall back to Studio's bundled JBR. */
export function gradleEnv(sdk: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (sdk) {
    env.ANDROID_HOME ??= sdk;
    env.ANDROID_SDK_ROOT ??= sdk;
  }
  if (!env.JAVA_HOME) {
    const studio = findStudio();
    const jbr = studio && [path.join(studio, "jbr"), path.join(studio, "Contents", "jbr")].find(existsSync);
    if (jbr) env.JAVA_HOME = jbr;
  }
  return env;
}
