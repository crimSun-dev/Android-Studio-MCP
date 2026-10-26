# android-studio-mcp

An MCP server that gives AI coding agents the Android Studio toolchain: Gradle builds, tests, and lint, plus device control through adb, the emulator, and opening files in Android Studio. It isn't tied to one IDE or one AI client. Any MCP client can use it: Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex, VS Code/Copilot, and ChatGPT (through HTTP mode).

## Tools

| Area | Tools |
|---|---|
| Setup | `environment`, `project_info`, `project_apks`, `sdk_manager`, `studio_open` |
| Build | `build`, `run_app` (build + install + launch, like Studio's ▶), `gradle_run`, `gradle_tasks`, `test_results`, `lint_results` |
| Device | `devices_list`, `device_info`, `app_install`, `app_uninstall`, `app_launch`, `app_stop`, `packages_list`, `logcat`, `adb_shell`, `file_transfer` |
| UI | `screenshot` (returns an image), `ui_dump` (nodes with tap coordinates), `input` (tap / swipe / text / key) |
| Emulator | `emulator_list`, `emulator_start`, `emulator_stop` |
| Jobs | `job_status`, `job_cancel` |
| Live IDE (needs the plugin) | `ide_status`, `ide_editors`, `ide_read_file` (unsaved buffers), `ide_problems` (one file), `ide_project_problems` (many files, no Gradle), `ide_open`, `ide_save_all`, `ide_find_files`, `ide_screenshot` (IDE window: Compose previews, layout editor) |
| Refactoring (plugin) | `ide_find_usages`, `ide_rename` (Shift+F6 semantics, Kotlin/Java aware) |
| Sync & run (plugin) | `ide_gradle_sync` (waits for the result), `ide_sync_status`, `ide_actions`, `ide_action`, `ide_run_configurations`, `ide_run` |

**Long operations run as jobs.** `build`, `run_app`, `gradle_run` and `emulator_start` wait up to `waitSec` (default 50s). If they haven't finished by then, they return `{status: "running", id}` and the agent polls `job_status`. This stays under the tool-call timeouts that Cursor, Codex and Gemini CLI enforce.

Build failures come back as structured diagnostics (`file`, `line`, `column`, `message`). They're parsed from Kotlin, javac, AAPT2, and Gradle's "What went wrong" block.

## Install

```sh
npm install
npm run build
```

Requires Node 20+, an Android SDK (platform-tools; emulator for the AVD tools), and a JDK. The JDK is taken from `JAVA_HOME`, falling back to Android Studio's bundled JBR.

## Configuration (env vars)

| Var | Purpose |
|---|---|
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` | SDK location. Falls back to the project's `local.properties` `sdk.dir`, then the default SDK path. |
| `ANDROID_STUDIO_HOME` | Android Studio install dir (for `studio_open` and the JBR fallback) when it's not in the default location. |
| `ANDROID_PROJECT_DIR` | Default project. Otherwise every project tool takes `projectDir`, or the server's cwd is searched upward. |
| `ASMCP_TOKEN`, `ASMCP_PORT` | HTTP mode only: auth token (random if unset) and port (default 3939). |

The examples below use this machine's paths. In JSON, write Windows paths with forward slashes or escaped backslashes.

### Claude Code

```sh
claude mcp add android-studio --scope user \
  -e ANDROID_SDK_ROOT="G:/Draven's Very Important Files/Workspace/Android Studio/Android" \
  -e ANDROID_STUDIO_HOME="G:/Draven's Very Important Files/Workspace/Android Studio/Android Studio Files" \
  -- node "G:/Draven's Very Important Files/Workspace/Android Studio/android-studio-mcp/dist/index.js"
```

Leave `ANDROID_PROJECT_DIR` unset. Claude Code starts the server in the folder you open, so it finds the project automatically.

### Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
### Cursor: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project)

```json
{
  "mcpServers": {
    "android-studio": {
      "command": "node",
      "args": ["G:/Draven's Very Important Files/Workspace/Android Studio/android-studio-mcp/dist/index.js"],
      "env": {
        "ANDROID_SDK_ROOT": "G:/Draven's Very Important Files/Workspace/Android Studio/Android",
        "ANDROID_STUDIO_HOME": "G:/Draven's Very Important Files/Workspace/Android Studio/Android Studio Files",
        "ANDROID_PROJECT_DIR": "G:/Draven's Very Important Files/Workspace/Android Studio/Apps"
      }
    }
  }
}
```

### Gemini CLI: `~/.gemini/settings.json`

Same `mcpServers` block as above. You can add `"timeout": 120000` (ms) to give the job tools room.

### Codex: `~/.codex/config.toml`

```toml
[mcp_servers.android-studio]
command = "node"
args = ["G:/Draven's Very Important Files/Workspace/Android Studio/android-studio-mcp/dist/index.js"]
tool_timeout_sec = 120

[mcp_servers.android-studio.env]
ANDROID_SDK_ROOT = "G:/Draven's Very Important Files/Workspace/Android Studio/Android"
ANDROID_STUDIO_HOME = "G:/Draven's Very Important Files/Workspace/Android Studio/Android Studio Files"
ANDROID_PROJECT_DIR = "G:/Draven's Very Important Files/Workspace/Android Studio/Apps"
```

### VS Code / GitHub Copilot: `.vscode/mcp.json`

```json
{ "servers": { "android-studio": { "type": "stdio", "command": "node", "args": ["…/dist/index.js"], "env": { "ANDROID_SDK_ROOT": "…" } } } }
```

### Android Studio itself (Gemini in Android Studio)

Recent Android Studio versions let Gemini's agent mode use MCP servers. Find the MCP Servers page under the Gemini / AI settings (the exact location varies by version), enable MCP, and paste the same `mcpServers` JSON.

### ChatGPT (HTTP mode)

ChatGPT only talks to remote MCP servers, so run the server in HTTP mode:

```sh
ASMCP_TOKEN=<long-random-secret> node dist/index.js --http 3939
```

Then expose it over HTTPS, for example with `cloudflared tunnel --url http://127.0.0.1:3939`. In ChatGPT → Settings → Connectors → Developer mode, add `https://<tunnel-host>/mcp/<token>` with no authentication. The token in the path is the credential. **Anyone with that URL can run shell commands on your devices and Gradle on your machine**, so keep it secret and stop the tunnel when you're done. Clients that can send headers can use `http://127.0.0.1:3939/mcp` with `Authorization: Bearer <token>` instead.

## Android Studio plugin (live IDE bridge)

`studio-plugin/` is a small IntelliJ Platform plugin. On startup it serves a token-protected HTTP endpoint on `127.0.0.1` (random port) and records the port and token in `~/.android-studio-mcp/bridges/<pid>.json`. The MCP server reads that file. When Studio is running, the `ide_*` tools work, and `build` / `run_app` save unsaved editors first. When it isn't running, everything else still works from the CLI.

```sh
cd studio-plugin
./gradlew buildPlugin            # compiles against the Studio in ANDROID_STUDIO_HOME (or -PstudioHome=...)
```

Install `studio-plugin/build/distributions/android-studio-mcp-bridge-0.1.0.zip` via Settings → Plugins → ⚙ → Install Plugin from Disk, then restart Studio.

Calls that open a modal dialog in Studio (a rename conflict, the exit confirmation) wait for the dialog to close. After 20s they return a "UI thread busy" error, and you handle the dialog in Studio.

## Development

```sh
npm run dev          # tsc --watch
npm run smoke        # spawn over stdio and call environment/project_info/devices_list/emulator_list
node scripts/smoke.mjs logcat '{"lines":20}' ui_dump '{}'   # call arbitrary tools
node scripts/poll.mjs run_app '{"waitSec":30}'              # start a job and poll it to completion
npm test             # parser + HTTP transport tests
npm run inspect      # MCP Inspector UI
```

## Roadmap

- Plugin: more refactorings (move, extract, change signature), project-wide inspections with quick-fixes, Layout Inspector snapshots, and headless Compose preview rendering (`ide_screenshot` captures previews shown in the IDE for now).
- Compose preview rendering, Logcat streaming via MCP notifications, `avdmanager` create/delete, instrumented-test sharding, and baseline profile / Macrobenchmark helpers.
