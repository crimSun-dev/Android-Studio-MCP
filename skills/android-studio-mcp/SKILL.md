---
name: android-studio-mcp
description: Attaches an agent to the local android-studio-mcp server over stdio, launches Android Studio or reuses the open window, proves the live IDE bridge, then does the Android task with the MCP tools (Gradle build/test/lint, run_app, adb, emulator, screenshots, UI input, live editor buffers, IDE problems, rename). Use when the user says "open Android Studio", "launch studio", "connect android studio mcp", "android studio mcp", "use the android studio tools", "build and run on the emulator", "run the app on my phone", "ide bridge", "check the IDE problems", or when the android-studio MCP server is missing, failing, or any android-studio tool call errors. Do NOT use for plain file edits when no Android toolchain is wanted, and do NOT use for Eclipse work (that is the eclipse-mcp-workbench skill).
compatibility: Claude Code, Claude Desktop, Cursor (same shape for Codex, Gemini CLI, VS Code). Requires Node 20+ and the android-studio-mcp checkout. Live IDE tools require Android Studio with the Android Studio MCP Bridge plugin. No outbound network.
metadata: {author: draven, version: 1.0.0, mcp-server: android-studio-mcp, category: development}
---

# Android Studio MCP

Drives the Android toolchain, and a live Android Studio, through the
`android-studio-mcp` stdio server (client server name: `android-studio`).
Gradle, adb, emulator and `studio_open` work without Studio running. The
`ide_*` tools only work once Studio is up with the bridge plugin.

**This is the inverse of the Eclipse skill.** Eclipse must never be started by
the agent. Android Studio **is** started by the agent, with `studio_open`,
whenever the task needs the IDE.

## Standing rule (read this first)

**Until `environment` has returned a real toolchain report in this session, the
turn is a connect job, not an Android task.**

- Never claim Connected from a green dot in a settings panel, a config entry
  that exists, or the absence of errors. Only a returned `environment` report
  counts.
- After it succeeds once, stop talking about connection and do the task.
  Follow-ups skip the probe. Re-probe only when a tool call fails.
- Never claim "Android Studio is connected" or "Studio up" until `ide_status`
  returns `running: true` with the project listed.

---

## Connect workflow

Run in order. Stop as soon as the probe succeeds.

### 1. Probe

If the `android-studio` tools are in the session (`environment`, `ide_status`,
`build`, …), call `environment` (pass `projectDir` if the user named a
project). A report with `sdk`, `androidStudio` and `project` fields means the
MCP is connected. Reply with one line:

```
Connected — <sdk path or "SDK missing">, Studio <found|not found>.
```

Then go to **3. Launch** if the task needs the IDE, or straight to the task if
it only needs Gradle / adb / emulator.

### 2. Tools absent → register, then stop

Say so in one line: `android-studio MCP tools aren't attached to this session.`
Do **not** edit the Android project with ordinary file tools and call that a
Studio session. Then:

1. **Find the checkout** (first hit wins; do not require env vars when one of
   these works):
   - the path already in the client's config (`args[0]` of an existing
     `android-studio` entry, minus `/dist/index.js`)
   - `ANDROID_STUDIO_MCP_HOME`
   - this machine's known checkout:
     `G:/Draven's Very Important Files/Workspace/Android Studio/android-studio-mcp`
   - a local clone of `crimSun-dev/Android-Studio-MCP` (folder named
     `android-studio-mcp` or `Android-Studio-MCP` whose `package.json` has
     `"name": "android-studio-mcp"`)
   - none found → ask the user where it is. Do not guess.
2. **Make sure it is built.** `dist/index.js` missing → `npm install` in the
   checkout (its `prepare` script compiles). If Studio or the plugin has never
   been installed on this machine, prefer `npm run setup`: it finds the SDK and
   Studio, builds and installs `studio-plugin/`, and registers every MCP client
   it finds (backs each config up as `*.bak-asmcp`). Node 20+ required.
3. **Register stdio** for the client you are running in (absolute path,
   forward slashes on Windows):
   - Claude Code:
     ```
     claude mcp add android-studio -s user -- node <abs>/dist/index.js
     ```
   - Cursor (`~/.cursor/mcp.json`) and Claude Desktop
     (`claude_desktop_config.json`): add or update only
     `mcpServers.android-studio`; never wipe unrelated servers.
     ```json
     { "mcpServers": { "android-studio": { "command": "node", "args": ["<abs>/dist/index.js"] } } }
     ```
   - Codex, Gemini CLI, VS Code: see `L3-REFERENCE.md#other-clients`.
4. **Stop.** Tell the user to reload / restart the client. When they say it was
   reloaded, go back to step 1. Do not invent success.

No bearer token is involved for stdio. Do not document HTTP mode, `ASMCP_TOKEN`
or a Cloudflare tunnel unless the user explicitly asks for ChatGPT remote
access (then see `L3-REFERENCE.md#http-mode`).

### 3. Launch (only when the IDE is needed)

Launch when the user asked to open Studio, or the task needs `ide_*` tools,
unsaved editor buffers, IDE analysis, refactoring, Gradle sync, or a live IDE.
If the task only needs Gradle, adb or the emulator, **do not launch Studio**.

1. `ide_status`. `running: true` and the project is in its open projects →
   already up, skip to the confirm line.
2. Bridge down → `studio_open` with `path` = the project directory (or a file
   plus `line` / `column`). With a bridge already up it asks that Studio to
   open the path; otherwise it spawns the real `studio` launcher. It reuses a
   running window.
3. The spawn message is **not** success. Studio cold start is slow (often
   30–120 s, longer while indexing). Poll `ide_status` a few times with real
   waits between calls (roughly 15–20 s, e.g. a shell `sleep`), not a tight
   loop, for up to about 3 minutes.
4. Success = `ide_status` reports `running: true` with the project listed.
   Confirm in one line, then do the task **in the same turn**:
   ```
   Studio up — <project>, bridge <version ide_status reports>.
   ```

### 4. Launch failures

| Symptom | Action |
|---|---|
| `studio_open` → "Android Studio not found" | Tell the user to set `ANDROID_STUDIO_HOME` to the Studio install directory, then stop. |
| Studio window is open but `ide_status` still `running: false` after polling | The bridge plugin is missing or stale. Run `npm run install-plugin [projectDir]` from the checkout; say first that it will quit and relaunch Studio. Then poll `ide_status` again. |
| `studio_open` → "No such file" | The path is wrong. Re-resolve with `environment` / `project_info`; do not retry blindly. |
| An `ide_*` call returns "UI thread busy" | A modal dialog is open in Studio. Ask the user to close it. |

**Never** read, print, or copy `~/.android-studio-mcp/bridges/<pid>.json`. The
server reads it; the agent does not need the token.

---

## Task rules

- Start with `environment` or `project_info` when the project is unknown.
- Discover argument schemas from the live tool list; do not rely on memorized
  parameter names.
- **Jobs.** `build`, `run_app`, `gradle_run`, `emulator_start` return
  `{status:"running", id}` after `waitSec` (default 50). Poll
  `job_status {id, waitSec}` (max 110) until it settles. Never start a second
  build because the first has not finished. `job_cancel` to abort.
- **Build errors** come back as structured `file` / `line` / `column` /
  `message`. Fix those, rebuild, and report what the rebuild returned.
- **Live editor.** `ide_read_file` and `ide_problems` see unsaved state; prefer
  them over disk reads while the user is editing in Studio.
  `ide_project_problems` checks many files without Gradle. `build` and
  `run_app` save editors first when the bridge is up.
- **UI checks:** `screenshot` → `ui_dump` → `input` using coordinates taken
  from `ui_dump`. Never guess tap coordinates.
- **After a crash:** `logcat` with crashes only.
- **Refactors:** `ide_find_usages` then `ide_rename` (Kotlin/Java aware), not a
  text find-and-replace.
- **Truth rule:** refuse to claim a compile, test, lint or UI result that no
  tool returned. Disk edits are not "verified in Studio" until `ide_problems`
  or a build says so.

Full tool catalog: `L3-REFERENCE.md#tools`.

---

## Examples

### Example 1 — Not attached (common first-run case)

**User asks:** "Open Android Studio on this project and run it on the emulator."

**Agent does:**
1. Sees no `android-studio` tools → `android-studio MCP tools aren't attached to this session.`
2. Finds the checkout via the existing Cursor entry; `dist/index.js` exists.
3. Running in Claude Code → runs
   `claude mcp add android-studio -s user -- node "G:/Draven's Very Important Files/Workspace/Android Studio/android-studio-mcp/dist/index.js"`.
4. Stops: "Registered. Restart Claude Code and tell me when it's back."
5. User: "reloaded" → `environment` → `Connected — C:/Users/…/Android/Sdk, Studio found.`
6. `ide_status` → down → `studio_open {path: <project>}` → polls `ide_status`
   → `Studio up — <project>, bridge <version>.`
7. `emulator_list` → `emulator_start` (poll job) → `run_app` (poll job) →
   `screenshot` to show it launched.

**Output format:**
```
android-studio MCP tools aren't attached to this session.
Registered `android-studio` (stdio → <abs>/dist/index.js). Restart the client and tell me when it's back.
```
…after reload:
```
Connected — <sdk>, Studio found.
Studio up — <project>, bridge <version>.
<task result: build status, APK, device, screenshot>
```

**Edge handled:** if `dist/index.js` is missing, the agent runs `npm install`
(or `npm run setup` if the plugin was never installed) before registering; if
no checkout can be found it asks for the path instead of inventing one.

### Example 2 — Connected, Gradle-only task (edge: don't launch Studio)

**User asks:** "Run the unit tests."

**Agent does:**
1. `environment` already succeeded this session → no probe, no connect line.
2. `gradle_run` with the test task → `{status:"running", id}` → `job_status
   {id, waitSec: 100}` until `succeeded` / `failed`.
3. `test_results` → reports pass/fail counts and the failing tests.

**Output format:** `42 passed, 1 failed — FooViewModelTest.loadsCache (expected 3, got 0).`
No Studio launch, no connection talk.

**Edge handled:** if the job is still `running` after one poll, the agent polls
again; it never starts a second `gradle_run`. If a tool call fails with a
transport error, it re-runs step 1 of the connect workflow.

---

## Do / Decide / Don't

- **[DO]** probe with `environment` first; prove the IDE with `ide_status`.
- **[DO]** launch Studio with `studio_open` when the task needs the IDE.
- **[DO]** poll jobs and Studio startup patiently.
- **[DECIDE]** whether the task needs the IDE at all. Gradle / adb / emulator
  work does not.
- **[DECIDE]** `npm run setup` (first install, plugin never built) vs plain
  `npm install` (server just needs compiling).
- **[DON'T]** claim Connected or Studio up without the tool output above.
- **[DON'T]** read or print the bridge token file.
- **[DON'T]** edit Java/Kotlin on disk and claim Studio verified it.
- **[DON'T]** overwrite unrelated MCP servers when editing a client config.
- **[DON'T]** use Chrome/browser MCP tools, or rebuild the server beyond
  `npm install` / `npm run setup` / `npm run install-plugin`.
