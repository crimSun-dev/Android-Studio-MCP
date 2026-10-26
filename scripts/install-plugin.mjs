// Build the bridge plugin, quit any running Android Studio through the bridge, install the plugin into Studio's
// plugins dir, and relaunch Studio (optionally on a project).
// Usage: node scripts/install-plugin.mjs [projectDir]   (needs ANDROID_STUDIO_HOME unless Studio is in the default location)
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDir = path.join(root, "studio-plugin");
const isWin = process.platform === "win32";

const { findStudio, studioLauncher } = await import(path.join(root, "dist", "env.js")).then((m) => m);
const { listBridges, callBridge } = await import(path.join(root, "dist", "bridge.js")).then((m) => m);

const studio = findStudio();
if (!studio) throw new Error("Android Studio not found; set ANDROID_STUDIO_HOME");

// 1. Build.
console.log("Building plugin…");
execFileSync(isWin ? "cmd.exe" : "./gradlew", isWin ? ["/d", "/c", "gradlew.bat", "buildPlugin", "--console=plain", "-q"] : ["buildPlugin", "--console=plain", "-q"], {
  cwd: pluginDir,
  stdio: "inherit",
  env: { ...process.env, ANDROID_STUDIO_HOME: studio },
});
const distDir = path.join(pluginDir, "build", "distributions");
const zip = readdirSync(distDir).filter((f) => f.endsWith(".zip")).map((f) => path.join(distDir, f))[0];

// 2. Quit running Studios (the plugin jar is locked while the IDE runs on Windows).
const bridges = listBridges();
for (const b of bridges) {
  console.log(`Asking ${b.ide} (pid ${b.pid}) to exit…`);
  await callBridge("exit").catch((e) => console.warn(`  exit request failed: ${e.message}`));
}
const deadline = Date.now() + 60_000;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
while (bridges.some((b) => alive(b.pid))) {
  if (Date.now() > deadline) throw new Error("Studio did not exit within 60s (a dialog may be asking something)");
  await new Promise((r) => setTimeout(r, 500));
}

// 3. Install into the config's plugins dir, e.g. %APPDATA%\Google\AndroidStudio2026.2.1\plugins.
const info = JSON.parse(readFileSync(path.join(studio, process.platform === "darwin" ? "Resources/product-info.json" : "product-info.json"), "utf8"));
const configBase = isWin
  ? path.join(process.env.APPDATA, "Google")
  : process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "Google")
    : path.join(homedir(), ".local", "share", "Google");
const plugins = path.join(configBase, info.dataDirectoryName, "plugins");
mkdirSync(plugins, { recursive: true });
const target = path.join(plugins, "android-studio-mcp-bridge");
rmSync(target, { recursive: true, force: true });
const tmp = path.join(plugins, ".asmcp-unzip");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
if (isWin) execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
else execFileSync("unzip", ["-q", zip, "-d", tmp]);
cpSync(path.join(tmp, "android-studio-mcp-bridge"), target, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
console.log(`Installed into ${target}`);

// 4. Relaunch.
const launcher = studioLauncher(studio);
const project = process.argv[2];
if (launcher && (bridges.length || project)) {
  spawn(launcher, project ? [path.resolve(project)] : [], { detached: true, stdio: "ignore" }).unref();
  console.log("Relaunched Android Studio");
}
if (!existsSync(target)) process.exit(1);
