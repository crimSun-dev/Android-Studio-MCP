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

## Quick start

```sh
git clone https://github.com/crimSun-dev/Android-Studio-MCP.git
cd Android-Studio-MCP
npm install        # also compiles the server
npm run setup
```

Requires Node 20+ and Android Studio (or at least an Android SDK). `npm run setup` takes care of the rest on Windows, macOS, and Linux:

1. Finds your Android SDK and Android Studio, wherever they're installed (see below).
2. Builds the Android Studio bridge plugin against your Studio and installs it.
3. Registers the server with every MCP client it finds: Claude Code, Cursor, Gemini CLI, Codex, Claude Desktop, and VS Code. Existing entries are updated, and each config file is backed up as `*.bak-asmcp`.

Restart your AI clients afterwards. Options: `--dry-run`, `--no-plugin`, `--clients=cursor,codex`. Re-run setup after moving the checkout.

### How paths are found

Nothing machine-specific is stored in the client configs. The entry only points at this checkout's `dist/index.js`, and every server start re-discovers the toolchain:

| What | Looked up in order |
|---|---|
| Android SDK | `ANDROID_SDK_ROOT`, `ANDROID_HOME`, the project's `local.properties`, SDKs registered in Android Studio's settings, the Windows registry, `adb` on `PATH`, default SDK locations |
| Android Studio | `ANDROID_STUDIO_HOME`, a running Studio with the plugin, the Windows registry, `studio` on `PATH`, JetBrains Toolbox installs, default install locations |
| Project | the tool's `projectDir` argument, `ANDROID_PROJECT_DIR`, the server's working directory (walking up), the project that's active in Android Studio |
| JDK for Gradle | `JAVA_HOME`, then Android Studio's bundled JBR |

The `environment` tool shows what was found. The env vars above are only needed for unusual layouts. `ASMCP_TOKEN` and `ASMCP_PORT` configure HTTP mode.

### Manual registration

If you'd rather not run setup, add one entry yourself, with `/path/to` pointing at your clone:

| Client | Config |
|---|---|
| Claude Code | `claude mcp add android-studio -s user -- node /path/to/Android-Studio-MCP/dist/index.js` |
| Cursor / Claude Desktop / Gemini CLI | `{"mcpServers": {"android-studio": {"command": "node", "args": ["/path/to/Android-Studio-MCP/dist/index.js"]}}}` in `~/.cursor/mcp.json`, `claude_desktop_config.json`, or `~/.gemini/settings.json` |
| Codex | `[mcp_servers.android-studio]` with `command = "node"`, `args = ["/path/to/Android-Studio-MCP/dist/index.js"]`, `tool_timeout_sec = 120` in `~/.codex/config.toml` |
| VS Code / Copilot | `{"servers": {"android-studio": {"type": "stdio", "command": "node", "args": ["/path/to/Android-Studio-MCP/dist/index.js"]}}}` in your user `mcp.json` |

On Windows, write paths with forward slashes in JSON and TOML.

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

`npm run setup` installs it. To update it after changing the plugin, run:

```sh
npm run install-plugin            # build, quit Studio via the bridge (no confirm dialog), install, relaunch
```

That builds against your detected Studio, using Studio's bundled JDK. To build by hand, run `cd studio-plugin && ./gradlew buildPlugin` with `ANDROID_STUDIO_HOME` set if Studio isn't in its default location. Then install `build/distributions/*.zip` via Settings → Plugins → ⚙ → Install Plugin from Disk.

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
