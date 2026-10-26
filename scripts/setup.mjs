// One-time setup on a new machine: build, detect the Android toolchain, install the Studio plugin, and register
// the server with every MCP client found. Safe to re-run (it updates entries in place and backs up each config).
//
// Usage: npm run setup [-- --dry-run] [-- --no-plugin] [-- --clients=claude-code,cursor,gemini,codex,claude-desktop,vscode]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryJs = path.join(root, "dist", "index.js");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyClients = args.find((a) => a.startsWith("--clients="))?.slice(10).split(",");
const home = homedir();
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const slash = (p) => p.replace(/\\/g, "/");

if (!existsSync(entryJs)) {
  console.log("Building server…");
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root, stdio: "inherit" });
}
const { sdkCandidates, studioCandidates } = await import(pathToFileURL(path.join(root, "dist", "env.js")).href);

// 1. Toolchain report. The server repeats this discovery on every start, so nothing needs to be written down;
//    this only tells the user what was found.
const sdk = sdkCandidates()[0];
const studio = studioCandidates()[0];
console.log(`Android SDK    : ${sdk ? `${sdk.path}  (from ${sdk.source})` : "NOT FOUND — install it via Android Studio's SDK Manager or set ANDROID_SDK_ROOT"}`);
console.log(`Android Studio : ${studio ? `${studio.path}  (from ${studio.source})` : "not found — IDE tools and the plugin need it; set ANDROID_STUDIO_HOME if it is installed somewhere unusual"}`);

// 2. Studio plugin.
if (!args.includes("--no-plugin") && studio && !dryRun) {
  console.log("\nInstalling the Android Studio bridge plugin…");
  try {
    execFileSync(process.execPath, [path.join(root, "scripts", "install-plugin.mjs")], { stdio: "inherit" });
  } catch {
    console.warn("Plugin install failed (see above). The CLI tools still work; re-run `node scripts/install-plugin.mjs` later.");
  }
}

// 3. MCP clients. The entry only references this checkout's dist/index.js; SDK/Studio are discovered at runtime.
const server = { command: "node", args: [slash(entryJs)] };
const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");

function backup(file) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-asmcp`);
}

/** Add/replace our entry in a JSON config. Only touches clients that are installed (their config dir exists). */
function upsertJson(file, key, value) {
  if (!existsSync(path.dirname(file))) return false;
  const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "{}") : {};
  json[key] ??= {};
  json[key]["android-studio"] = value;
  if (!dryRun) {
    backup(file);
    writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }
  return true;
}

function upsertCodex(file) {
  if (!existsSync(path.dirname(file))) return false;
  let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Drop any previous android-studio tables (main + .env) before appending the current one.
  toml = toml.replace(/\n?\[mcp_servers\.android-studio(?:\.[\w-]+)?\][\s\S]*?(?=\n\[|$)/g, "");
  const q = (s) => JSON.stringify(s);
  toml = toml.replace(/\s*$/, "\n") + `\n[mcp_servers.android-studio]\ncommand = ${q(server.command)}\nargs = [${server.args.map(q).join(", ")}]\ntool_timeout_sec = 120\n`;
  if (!dryRun) {
    backup(file);
    writeFileSync(file, toml);
  }
  return true;
}

function claudeCode() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", shell: isWin });
  } catch {
    return false;
  }
  if (dryRun) return true;
  try {
    execFileSync("claude", ["mcp", "remove", "android-studio", "-s", "user"], { stdio: "ignore", shell: isWin });
  } catch {
    /* not registered yet */
  }
  const quoted = isWin ? `"${server.args[0]}"` : server.args[0];
  execFileSync("claude", ["mcp", "add", "android-studio", "-s", "user", "--", server.command, quoted], { stdio: "ignore", shell: isWin });
  return true;
}

const clients = {
  "claude-code": claudeCode,
  cursor: () => upsertJson(path.join(home, ".cursor", "mcp.json"), "mcpServers", server),
  gemini: () => upsertJson(path.join(home, ".gemini", "settings.json"), "mcpServers", { ...server, timeout: 120000 }),
  codex: () => upsertCodex(path.join(home, ".codex", "config.toml")),
  "claude-desktop": () =>
    upsertJson(
      isWin ? path.join(appData, "Claude", "claude_desktop_config.json") : isMac ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") : path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      "mcpServers",
      server,
    ),
  vscode: () =>
    upsertJson(
      isWin ? path.join(appData, "Code", "User", "mcp.json") : isMac ? path.join(home, "Library", "Application Support", "Code", "User", "mcp.json") : path.join(home, ".config", "Code", "User", "mcp.json"),
      "servers",
      { type: "stdio", ...server },
    ),
};

console.log(`\nRegistering MCP server${dryRun ? " (dry run)" : ""}:`);
for (const [name, register] of Object.entries(clients)) {
  if (onlyClients && !onlyClients.includes(name)) continue;
  let status;
  try {
    status = register() ? (dryRun ? "would register" : "registered") : "not installed, skipped";
  } catch (e) {
    status = `failed: ${e.message}`;
  }
  console.log(`  ${name.padEnd(15)} ${status}`);
}
console.log(`
Done. Restart your AI clients to pick up the server.
ChatGPT (remote MCP only): run \`node dist/index.js --http\` and see the README's ChatGPT section.`);
