import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { z } from "zod";
import { emulatorPath, requireSdk } from "../env.js";
import { run, spawnDetached } from "../exec.js";
import { describeJob, startJob, waitForJob } from "../jobs.js";
import { adb, json, listDevices, safe, shell, text } from "../util.js";

async function listAvds(): Promise<string[]> {
  const emu = emulatorPath(requireSdk());
  if (!existsSync(emu)) throw new Error("Emulator package is not installed in the SDK.");
  const res = await run(emu, ["-list-avds"], { timeoutMs: 30_000 });
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    // The emulator prints INFO/WARNING lines on some hosts; AVD names never contain '|' or spaces.
    .filter((l) => l && !/^(INFO|WARNING|ERROR)\b/.test(l) && !/\s/.test(l));
}

/** Map running emulator serials to AVD names. */
async function runningAvds(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await listDevices()) {
    if (!d.serial.startsWith("emulator-")) continue;
    const res = await adb(["emu", "avd", "name"], d.serial, 10_000).catch(() => undefined);
    const name = res?.stdout.split(/\r?\n/)[0]?.trim();
    if (name) out[d.serial] = name;
  }
  return out;
}

export function registerEmulatorTools(server: McpServer) {
  server.registerTool(
    "emulator_list",
    {
      title: "List AVDs",
      description: "List Android Virtual Devices and which are currently running (with their serials).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const [avds, running] = await Promise.all([listAvds(), runningAvds()]);
      const bySerial = Object.entries(running);
      return json(
        avds.map((name) => ({ name, running: bySerial.find(([, n]) => n === name)?.[0] ?? null })),
      );
    }),
  );

  server.registerTool(
    "emulator_start",
    {
      title: "Start emulator",
      description:
        "Boot an AVD in the background and wait for it to finish booting. Returns a job; if it isn't done within waitSec, poll it with job_status.",
      inputSchema: {
        avd: z.string().describe("AVD name from emulator_list"),
        coldBoot: z.boolean().default(false).describe("Ignore the quick-boot snapshot"),
        wipeData: z.boolean().default(false).describe("Factory-reset the AVD first (destroys its data)"),
        headless: z.boolean().default(false).describe("Run without a window (-no-window)"),
        waitSec: z.number().int().min(0).max(110).default(45).describe("How long to wait before returning the job"),
      },
    },
    safe(async (a) => {
      const sdk = requireSdk();
      const avds = await listAvds();
      if (!avds.includes(a.avd)) throw new Error(`Unknown AVD "${a.avd}". Available: ${avds.join(", ") || "(none)"}`);
      const already = Object.entries(await runningAvds()).find(([, n]) => n === a.avd);
      if (already) return text(`${a.avd} is already running as ${already[0]}.`);

      const before = new Set((await listDevices()).map((d) => d.serial));
      const args = ["-avd", a.avd, "-no-boot-anim"];
      if (a.coldBoot) args.push("-no-snapshot-load");
      if (a.wipeData) args.push("-wipe-data");
      if (a.headless) args.push("-no-window", "-no-audio");
      const pid = spawnDetached(emulatorPath(sdk), args);

      const job = startJob(`emulator_start ${a.avd}`, async (ctx) => {
        ctx.log(`Launched emulator pid ${pid}: emulator ${args.join(" ")}\n`);
        const deadline = Date.now() + 5 * 60_000;
        let serial: string | undefined;
        while (Date.now() < deadline && !ctx.isCancelled()) {
          if (!serial) {
            serial = (await listDevices()).find((d) => d.serial.startsWith("emulator-") && !before.has(d.serial))?.serial;
            if (serial) ctx.log(`Device appeared as ${serial}\n`);
          } else {
            const booted = await shell(serial, "getprop sys.boot_completed", 10_000).catch(() => "");
            if (booted.trim() === "1") {
              ctx.log("Boot completed\n");
              return { serial, avd: a.avd };
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error("Emulator did not finish booting within 5 minutes.");
      });
      await waitForJob(job, a.waitSec * 1000);
      return json(describeJob(job));
    }),
  );

  server.registerTool(
    "emulator_stop",
    {
      title: "Stop emulator",
      description: "Shut down a running emulator by serial (e.g. emulator-5554).",
      inputSchema: { serial: z.string().regex(/^emulator-\d+$/) },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      await adb(["emu", "kill"], a.serial, 20_000);
      return text(`Sent kill to ${a.serial}`);
    }),
  );
}
