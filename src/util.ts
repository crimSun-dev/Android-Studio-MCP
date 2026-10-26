import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { adbPath, requireSdk } from "./env.js";
import { run, type ExecResult } from "./exec.js";

export const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

export const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Wrap a tool handler so thrown errors become MCP tool errors instead of protocol errors. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

/** Run adb, optionally targeting one device. Throws with adb's stderr on failure. */
export async function adb(args: string[], serial?: string, timeoutMs = 60_000): Promise<ExecResult> {
  const full = serial ? ["-s", serial, ...args] : args;
  const res = await run(adbPath(requireSdk()), full, { timeoutMs });
  if (res.timedOut) throw new Error(`adb ${args.join(" ")} timed out after ${timeoutMs} ms`);
  if (res.code !== 0) throw new Error(`adb ${args.join(" ")} failed (${res.code}): ${(res.stderr || res.stdout).trim()}`);
  return res;
}

export interface Device {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
}

export async function listDevices(): Promise<Device[]> {
  const res = await adb(["devices", "-l"]);
  return res.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const d: Device = { serial, state };
      for (const kv of rest) {
        const [k, v] = kv.split(":");
        if (k === "model") d.model = v;
        else if (k === "product") d.product = v;
        else if (k === "device") d.device = v;
        else if (k === "transport_id") d.transportId = v;
      }
      return d;
    });
}

/** Pick the target device: the given serial, or the only connected one. */
export async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const online = (await listDevices()).filter((d) => d.state === "device");
  if (online.length === 1) return online[0].serial;
  if (online.length === 0) throw new Error("No device or emulator online. Start one with emulator_start or connect a device.");
  throw new Error(`Multiple devices online (${online.map((d) => d.serial).join(", ")}); pass serial.`);
}

/** Run `adb shell` with a single command string, returning stdout. */
export async function shell(serial: string, command: string, timeoutMs = 60_000): Promise<string> {
  return (await adb(["shell", command], serial, timeoutMs)).stdout;
}

/** Single-quote a value for the device's /system/bin/sh. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
