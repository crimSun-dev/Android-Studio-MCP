import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { adbPath, requireSdk } from "../env.js";
import { run, runBinary, tail } from "../exec.js";
import { adb, json, listDevices, resolveSerial, safe, shell, shq, text } from "../util.js";

const serial = z.string().optional().describe("Device serial from devices_list. Optional when exactly one device is online.");
const pkg = z
  .string()
  .regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, "must be a package name like com.example.app")
  .describe("Application package / applicationId");

interface UiNode {
  text?: string;
  desc?: string;
  id?: string;
  cls: string;
  center: [number, number];
  bounds: string;
  clickable?: true;
  scrollable?: true;
  focused?: true;
  checked?: true;
  enabled?: false;
}

/** Compress a uiautomator dump into the nodes an agent can act on, with tap coordinates. */
function parseUiDump(xml: string, includeAll: boolean): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
    const b = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    const n: UiNode = {
      cls: (attrs.class ?? "").replace(/^android\.(widget|view)\./, ""),
      center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
      bounds: attrs.bounds,
    };
    if (attrs.text) n.text = attrs.text;
    if (attrs["content-desc"]) n.desc = attrs["content-desc"];
    if (attrs["resource-id"]) n.id = attrs["resource-id"];
    if (attrs.clickable === "true") n.clickable = true;
    if (attrs.scrollable === "true") n.scrollable = true;
    if (attrs.focused === "true") n.focused = true;
    if (attrs.checked === "true") n.checked = true;
    if (attrs.enabled === "false") n.enabled = false;
    if (includeAll || n.text || n.desc || n.clickable || n.scrollable || n.id) nodes.push(n);
  }
  return nodes;
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

/** Encode text for `input text`: spaces become %s and shell metacharacters are escaped. */
function inputTextArg(s: string): string {
  return s.replace(/([\\"'`$&|;<>()*?~!#\[\]{}])/g, "\\$1").replace(/ /g, "%s");
}

export function registerDeviceTools(server: McpServer) {
  server.registerTool(
    "devices_list",
    {
      title: "List devices",
      description: "List connected Android devices and running emulators (adb devices -l).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => json(await listDevices())),
  );

  server.registerTool(
    "device_info",
    {
      title: "Device info",
      description: "Model, Android version, API level, ABI, screen size and density of a device.",
      inputSchema: { serial },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const props = await shell(s, "getprop");
      const prop = (k: string) => props.match(new RegExp(`\\[${k.replace(/\./g, "\\.")}\\]: \\[([^\\]]*)\\]`))?.[1];
      const size = (await shell(s, "wm size")).trim();
      const density = (await shell(s, "wm density")).trim();
      return json({
        serial: s,
        manufacturer: prop("ro.product.manufacturer"),
        model: prop("ro.product.model"),
        android: prop("ro.build.version.release"),
        sdk: prop("ro.build.version.sdk"),
        abi: prop("ro.product.cpu.abi"),
        emulator: prop("ro.kernel.qemu") === "1" || s.startsWith("emulator-"),
        avdName: prop("ro.boot.qemu.avd_name") ?? prop("ro.kernel.qemu.avd_name"),
        bootCompleted: prop("sys.boot_completed") === "1",
        screen: size,
        density,
      });
    }),
  );

  server.registerTool(
    "adb_shell",
    {
      title: "Run adb shell command",
      description:
        "Run an arbitrary shell command on the device (e.g. 'pm list packages -3', 'dumpsys battery'). Output is truncated to the tail.",
      inputSchema: {
        serial,
        command: z.string().min(1).describe("Command line run by the device shell"),
        timeoutSec: z.number().int().min(1).max(600).default(60),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      // Run directly rather than via adb(): a failing command's output is still useful to the caller.
      const res = await run(adbPath(requireSdk()), ["-s", s, "shell", a.command], { timeoutMs: a.timeoutSec * 1000 });
      const body = res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
      const status = res.timedOut ? "\n[timed out]" : res.code ? `\n[exit ${res.code}]` : "";
      return text(tail(body) + status || "(no output)");
    }),
  );

  server.registerTool(
    "app_install",
    {
      title: "Install APK",
      description: "Install (or reinstall, keeping data) an APK on a device. Use project_apks to find built APKs.",
      inputSchema: {
        serial,
        apkPath: z.string().describe("Absolute path to the .apk on this machine"),
        grantPermissions: z.boolean().default(false).describe("Grant all runtime permissions (-g)"),
        allowDowngrade: z.boolean().default(false),
      },
      annotations: { destructiveHint: false },
    },
    safe(async (a) => {
      if (!existsSync(a.apkPath)) throw new Error(`APK not found: ${a.apkPath}`);
      const s = await resolveSerial(a.serial);
      const flags = ["-r", "-t", ...(a.grantPermissions ? ["-g"] : []), ...(a.allowDowngrade ? ["-d"] : [])];
      const res = await adb(["install", ...flags, path.resolve(a.apkPath)], s, 300_000);
      return text(res.stdout.trim());
    }),
  );

  server.registerTool(
    "app_uninstall",
    {
      title: "Uninstall app",
      description: "Uninstall an app package from a device.",
      inputSchema: { serial, package: pkg, keepData: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const res = await adb(["uninstall", ...(a.keepData ? ["-k"] : []), a.package], s);
      return text(res.stdout.trim());
    }),
  );

  server.registerTool(
    "app_launch",
    {
      title: "Launch app",
      description: "Start an app's launcher activity (or a given activity) and report launch time.",
      inputSchema: {
        serial,
        package: pkg,
        activity: z.string().optional().describe("Activity class, e.g. .MainActivity or com.x.MainActivity. Defaults to the launcher activity."),
        stopFirst: z.boolean().default(true).describe("Force-stop the app before launching (cold start)"),
      },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      let component = a.activity ? `${a.package}/${a.activity}` : undefined;
      if (!component) {
        const resolved = await shell(s, `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${a.package}`);
        component = resolved.trim().split(/\r?\n/).pop();
        if (!component?.includes("/")) throw new Error(`No launcher activity for ${a.package}. Is it installed? (${resolved.trim()})`);
      }
      const out = await shell(s, `am start -W ${a.stopFirst ? "-S " : ""}-n ${shq(component)}`, 60_000);
      if (/Error:/.test(out)) throw new Error(out.trim());
      return text(out.trim());
    }),
  );

  server.registerTool(
    "app_stop",
    {
      title: "Force-stop app",
      description: "Force-stop an app, optionally also clearing all of its data.",
      inputSchema: { serial, package: pkg, clearData: z.boolean().default(false).describe("pm clear: wipes the app's data") },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      if (a.clearData) return text((await shell(s, `pm clear ${a.package}`)).trim());
      await shell(s, `am force-stop ${a.package}`);
      return text(`Stopped ${a.package}`);
    }),
  );

  server.registerTool(
    "packages_list",
    {
      title: "List packages",
      description: "List installed packages, third-party only by default.",
      inputSchema: { serial, thirdPartyOnly: z.boolean().default(true), filter: z.string().optional().describe("Substring filter") },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const out = await shell(s, `pm list packages${a.thirdPartyOnly ? " -3" : ""}`);
      const list = out
        .split(/\r?\n/)
        .map((l) => l.replace(/^package:/, "").trim())
        .filter((p) => p && (!a.filter || p.includes(a.filter)))
        .sort();
      return json(list);
    }),
  );

  server.registerTool(
    "logcat",
    {
      title: "Read logcat",
      description:
        "Read recent device logs. Filter by app package (uses its current PID), minimum priority, tag, or a regex. Use crashesOnly to get the crash buffer.",
      inputSchema: {
        serial,
        package: pkg.optional().describe("Only logs from this app's running process"),
        lines: z.number().int().min(1).max(5000).default(300).describe("Number of most recent lines to read"),
        minPriority: z.enum(["V", "D", "I", "W", "E", "F"]).default("V"),
        tag: z.string().optional().describe("Only this log tag"),
        grep: z.string().optional().describe("JavaScript regex applied to each line"),
        crashesOnly: z.boolean().default(false).describe("Read the crash buffer (uncaught exceptions, ANRs)"),
        clear: z.boolean().default(false).describe("Clear the log buffer after reading"),
      },
      annotations: { readOnlyHint: false },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const args = ["logcat", "-d", "-v", "threadtime", "-t", String(a.lines)];
      if (a.crashesOnly) args.push("-b", "crash");
      if (a.package) {
        const pid = (await shell(s, `pidof ${a.package}`).catch(() => "")).trim().split(/\s+/)[0];
        if (!pid) throw new Error(`${a.package} is not running (no PID). Launch it, or use crashesOnly to see past crashes.`);
        args.push(`--pid=${pid}`);
      }
      if (a.tag) args.push(`${a.tag}:${a.minPriority}`, "*:S");
      else args.push(`*:${a.minPriority}`);
      const res = await adb(args, s, 60_000);
      let lines = res.stdout.split(/\r?\n/);
      if (a.grep) {
        const re = new RegExp(a.grep, "i");
        lines = lines.filter((l) => re.test(l));
      }
      if (a.clear) await adb(["logcat", "-c"], s);
      return text(tail(lines.join("\n")) || "(no matching log lines)");
    }),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description: "Capture the device screen as a PNG image. Optionally also save it to a file on this machine.",
      inputSchema: { serial, savePath: z.string().optional().describe("Also write the PNG to this path") },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const png = await runBinary(adbPath(requireSdk()), ["-s", s, "exec-out", "screencap", "-p"]);
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("Device did not return a PNG (is the screen on?)");
      if (a.savePath) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(a.savePath, png);
      }
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }),
  );

  server.registerTool(
    "ui_dump",
    {
      title: "Dump UI hierarchy",
      description:
        "Dump the on-screen view hierarchy via uiautomator, as a compact list of nodes with text, resource-id, content-desc and tap-ready center coordinates.",
      inputSchema: {
        serial,
        includeAll: z.boolean().default(false).describe("Include layout-only nodes without text/id/clickability"),
        raw: z.boolean().default(false).describe("Return the raw XML instead"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const remote = "/data/local/tmp/asmcp_ui.xml";
      const out = await shell(s, `uiautomator dump --compressed ${remote}`, 30_000);
      if (!/dumped/i.test(out)) throw new Error(`uiautomator dump failed: ${out.trim()}`);
      const xml = await shell(s, `cat ${remote}`);
      if (a.raw) return text(tail(xml));
      return json(parseUiDump(xml, a.includeAll));
    }),
  );

  server.registerTool(
    "input",
    {
      title: "Send input",
      description:
        "Drive the device UI: tap or long-press at coordinates, swipe, type text, or press a key (BACK, HOME, ENTER, APP_SWITCH, DEL, or any KEYCODE_*). Get coordinates from ui_dump.",
      inputSchema: {
        serial,
        action: z.enum(["tap", "long_press", "swipe", "text", "key"]),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        x2: z.number().int().optional().describe("Swipe end x"),
        y2: z.number().int().optional().describe("Swipe end y"),
        durationMs: z.number().int().min(1).max(10_000).optional().describe("Swipe / long-press duration"),
        text: z.string().optional().describe("Text to type (for action=text)"),
        key: z.string().optional().describe("Key name or keycode (for action=key)"),
      },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const need = (...k: (keyof typeof a)[]) => {
        for (const key of k) if (a[key] === undefined) throw new Error(`${a.action} requires ${k.join(", ")}`);
      };
      let cmd: string;
      switch (a.action) {
        case "tap":
          need("x", "y");
          cmd = `input tap ${a.x} ${a.y}`;
          break;
        case "long_press":
          need("x", "y");
          cmd = `input swipe ${a.x} ${a.y} ${a.x} ${a.y} ${a.durationMs ?? 800}`;
          break;
        case "swipe":
          need("x", "y", "x2", "y2");
          cmd = `input swipe ${a.x} ${a.y} ${a.x2} ${a.y2} ${a.durationMs ?? 300}`;
          break;
        case "text":
          need("text");
          cmd = `input text ${shq(inputTextArg(a.text!))}`;
          break;
        case "key": {
          need("key");
          const k = a.key!.toUpperCase();
          if (!/^(KEYCODE_)?[A-Z0-9_]+$/.test(k)) throw new Error(`Invalid key: ${a.key}`);
          cmd = `input keyevent ${/^\d+$/.test(k) || k.startsWith("KEYCODE_") ? k : `KEYCODE_${k}`}`;
          break;
        }
      }
      await shell(s, cmd);
      return text(`ok: ${cmd}`);
    }),
  );

  server.registerTool(
    "file_transfer",
    {
      title: "Push / pull file",
      description: "Copy a file between this machine and the device (adb push / adb pull).",
      inputSchema: {
        serial,
        direction: z.enum(["push", "pull"]),
        localPath: z.string(),
        devicePath: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      const s = await resolveSerial(a.serial);
      const args = a.direction === "push" ? ["push", a.localPath, a.devicePath] : ["pull", a.devicePath, a.localPath];
      const res = await adb(args, s, 300_000);
      return text((res.stdout + res.stderr).trim());
    }),
  );
}
