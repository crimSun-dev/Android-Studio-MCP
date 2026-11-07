# android-studio-mcp — reference

Derived from the server's `README.md`, `src/index.ts`, `src/bridge.ts`,
`src/tools/*.ts` and `scripts/*.mjs`. When in doubt, the live tool list wins.

## Contents
- [tools](#tools)
- [other-clients](#other-clients)
- [discovery](#discovery)
- [npm-scripts](#npm-scripts)
- [bridge](#bridge)
- [http-mode](#http-mode)

## tools

| Area | Tools | Needs Studio? |
|---|---|---|
| Setup | `environment`, `project_info`, `project_apks`, `sdk_manager`, `studio_open` | No |
| Build | `build`, `run_app` (build + install + launch), `gradle_run`, `gradle_tasks`, `test_results`, `lint_results` | No (saves editors first if bridge up) |
| Device | `devices_list`, `device_info`, `app_install`, `app_uninstall`, `app_launch`, `app_stop`, `packages_list`, `logcat`, `adb_shell`, `file_transfer` | No |
| UI | `screenshot`, `ui_dump` (nodes with tap coordinates), `input` (tap / swipe / text / key) | No |
| Emulator | `emulator_list`, `emulator_start`, `emulator_stop` | No |
| Jobs | `job_status` (`id`, `waitSec` ≤ 110, `logChars`), `job_cancel` | No |
| Live IDE | `ide_status`, `ide_editors`, `ide_read_file`, `ide_problems`, `ide_project_problems`, `ide_open`, `ide_save_all`, `ide_find_files`, `ide_screenshot` | Yes |
| Refactor | `ide_find_usages`, `ide_rename` | Yes |
| Sync & run | `ide_gradle_sync`, `ide_sync_status`, `ide_actions`, `ide_action`, `ide_run_configurations`, `ide_run` | Yes |

- Jobs: `build`, `run_app`, `gradle_run`, `emulator_start` wait up to `waitSec`
  (default 50) then return `{status:"running", id}`. Job states: `running`,
  `succeeded`, `failed`, `cancelled`.
- `ide_status` with no bridge returns `{running:false, hint}`; with a bridge,
  `running:true` plus Studio's version, open projects and indexing state.
- `lint_results` parses the XML report; run `gradle_run` with `lintDebug` first.
- `sdk_manager` needs the SDK Command-line Tools package.
- Modal dialogs in Studio block IDE calls; after 20 s they fail with
  "UI thread busy".

## other-clients

All stdio, server name `android-studio`, absolute path, forward slashes on Windows.

| Client | Config |
|---|---|
| Claude Code | `claude mcp add android-studio -s user -- node <abs>/dist/index.js` |
| Cursor / Claude Desktop / Gemini CLI | `{"mcpServers": {"android-studio": {"command": "node", "args": ["<abs>/dist/index.js"]}}}` in `~/.cursor/mcp.json`, `claude_desktop_config.json`, or `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.android-studio]` with `command = "node"`, `args = ["<abs>/dist/index.js"]`, `tool_timeout_sec = 120` |
| VS Code / Copilot | user `mcp.json`: `{"servers": {"android-studio": {"type": "stdio", "command": "node", "args": ["<abs>/dist/index.js"]}}}` |

Merge into existing files; update an existing `android-studio` entry; leave
every other server untouched. Re-run `npm run setup` (or re-register) after
moving the checkout.

## discovery

Client configs only point at `dist/index.js`. Each server start re-discovers:

| What | Order |
|---|---|
| Android SDK | `ANDROID_SDK_ROOT`, `ANDROID_HOME`, project `local.properties`, SDKs registered in Studio, Windows registry, `adb` on PATH, default locations |
| Android Studio | `ANDROID_STUDIO_HOME`, a running Studio with the plugin, Windows registry, `studio` on PATH, JetBrains Toolbox, default locations |
| Project | tool `projectDir` arg, `ANDROID_PROJECT_DIR`, server cwd (walking up), the project active in Studio |
| JDK for Gradle | `JAVA_HOME`, then Studio's bundled JBR |

Env vars are only for unusual layouts. `environment` shows what was found.

## npm-scripts

Run from the checkout. Node 20+.

| Command | What it does |
|---|---|
| `npm install` | Installs deps and compiles `dist/` (via `prepare`). |
| `npm run setup` | Finds SDK + Studio, builds and installs `studio-plugin/`, registers every MCP client found (backs configs up as `*.bak-asmcp`). Flags: `--dry-run`, `--no-plugin`, `--clients=cursor,codex`. |
| `npm run install-plugin [projectDir]` | Builds the plugin, asks running Studios to exit through the bridge (fails after 60 s if a dialog blocks), installs into Studio's plugins dir, relaunches Studio (optionally on `projectDir`). |
| `npm run smoke` | Spawns the server over stdio and calls a few tools — a manual check outside the client. |

## bridge

The plugin serves a token-protected HTTP endpoint on `127.0.0.1` (random port)
and writes `~/.android-studio-mcp/bridges/<pid>.json`. The server reads the
newest live one and deletes files left by dead PIDs. The agent never reads,
prints or copies this file — use `ide_status` instead.

## http-mode

Only when the user explicitly asks for ChatGPT / remote access:
`ASMCP_TOKEN=<secret> node dist/index.js --http 3939`, exposed over HTTPS (e.g.
a cloudflared tunnel), connector URL `https://<host>/mcp/<token>`. Warn that
anyone with that URL can run shell commands on their devices and Gradle on
their machine, and to stop the tunnel when done.
