import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Client for the Android Studio plugin (studio-plugin/). Each running Studio writes
 * ~/.android-studio-mcp/bridges/<pid>.json with its localhost port and token.
 */
export interface BridgeInfo {
  port: number;
  token: string;
  pid: number;
  ide: string;
  build: string;
  bridgeVersion: string;
  startedAt: number;
  /** Studio's install dir (older bridge builds omit it). */
  home?: string;
}

export const bridgeDir = path.join(homedir(), ".android-studio-mcp", "bridges");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Running bridges, newest first. Files left behind by crashed IDEs are removed. */
export function listBridges(): BridgeInfo[] {
  if (!existsSync(bridgeDir)) return [];
  const out: BridgeInfo[] = [];
  for (const name of readdirSync(bridgeDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(bridgeDir, name);
    try {
      const info = JSON.parse(readFileSync(file, "utf8")) as BridgeInfo;
      if (alive(info.pid)) out.push(info);
      else unlinkSync(file);
    } catch {
      /* partially written or unreadable; skip */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export class BridgeUnavailable extends Error {}

export async function callBridge<T = unknown>(method: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const bridges = listBridges();
  if (!bridges.length) {
    throw new BridgeUnavailable(
      "Android Studio bridge not running. Open Android Studio with the 'Android Studio MCP Bridge' plugin installed " +
        "(build it from studio-plugin/ with gradlew buildPlugin, then Settings → Plugins → ⚙ → Install Plugin from Disk).",
    );
  }
  const b = bridges[0];
  const res = await fetch(`http://127.0.0.1:${b.port}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: Error) => {
    throw new BridgeUnavailable(`Android Studio bridge at port ${b.port} not reachable: ${e.message}`);
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `bridge ${method} failed with HTTP ${res.status}`);
  return body;
}

/** Best effort: flush unsaved editor buffers so a CLI Gradle build sees what the user sees. */
export async function saveAllIfIdeRunning(): Promise<string[] | undefined> {
  if (!listBridges().length) return undefined;
  try {
    return (await callBridge<{ saved: string[] }>("save_all", {}, 10_000)).saved;
  } catch {
    return undefined;
  }
}
