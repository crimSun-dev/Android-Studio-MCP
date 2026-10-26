import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Called with each chunk of combined output, for streaming into job logs. */
  onOutput?: (chunk: string) => void;
  /** Receives the child's PID, e.g. so a job can kill it on cancel. */
  onSpawn?: (pid: number | undefined) => void;
  input?: string;
}

const isWindows = process.platform === "win32";

/** Quote one argument for cmd.exe. Only needed for .bat/.cmd launchers (gradlew.bat). */
function cmdQuote(arg: string): string {
  if (/^[\w:.\\\/=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnFor(file: string, args: string[], opts: SpawnOptions) {
  if (isWindows && /\.(bat|cmd)$/i.test(file)) {
    const line = [file, ...args].map(cmdQuote).join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(file, args, opts);
}

/** Run a process without a shell, capturing text output. Never throws for non-zero exit. */
export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnFor(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
    });
    opts.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
      opts.onOutput?.(d);
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
      opts.onOutput?.(d);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Run a process and capture raw stdout bytes (screenshots, binary pulls). */
export function runBinary(file: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => killTree(child.pid), timeoutMs);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${file} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Start a process that outlives the call (the emulator). */
export function spawnDetached(file: string, args: string[], env?: NodeJS.ProcessEnv): number | undefined {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, env: env ?? process.env });
  child.unref();
  return child.pid;
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

/** Keep the tail of long output so tool results stay within client limits. */
export function tail(text: string, maxChars = 40_000): string {
  if (text.length <= maxChars) return text;
  return `…[${text.length - maxChars} earlier chars truncated]…\n` + text.slice(-maxChars);
}
