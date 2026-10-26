import { randomUUID } from "node:crypto";
import { tail } from "./exec.js";

/**
 * Long-running work (Gradle builds, emulator boots, deploys) runs as a background job so that
 * clients with short tool-call timeouts (Cursor, Codex, Gemini CLI) can start it and poll.
 */
export interface Job {
  id: string;
  name: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  log: string;
  result?: unknown;
  error?: string;
  cancel?: () => void;
}

export interface JobContext {
  log: (text: string) => void;
  onCancel: (fn: () => void) => void;
  isCancelled: () => boolean;
}

const jobs = new Map<string, Job>();
const MAX_LOG = 2_000_000;
const MAX_JOBS = 50;

export function startJob(name: string, work: (ctx: JobContext) => Promise<unknown>): Job {
  const job: Job = { id: randomUUID().slice(0, 8), name, status: "running", startedAt: Date.now(), log: "" };
  const cancelFns: (() => void)[] = [];
  job.cancel = () => {
    if (job.status !== "running") return;
    job.status = "cancelled";
    job.finishedAt = Date.now();
    cancelFns.forEach((f) => f());
  };
  const ctx: JobContext = {
    log: (t) => {
      job.log += t;
      if (job.log.length > MAX_LOG) job.log = job.log.slice(-MAX_LOG);
    },
    onCancel: (f) => cancelFns.push(f),
    isCancelled: () => job.status === "cancelled",
  };
  jobs.set(job.id, job);
  prune();
  work(ctx).then(
    (result) => {
      if (job.status !== "running") return;
      job.result = result;
      job.status = "succeeded";
      job.finishedAt = Date.now();
    },
    (err: unknown) => {
      if (job.status !== "running") return;
      job.error = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.finishedAt = Date.now();
    },
  );
  return job;
}

function prune() {
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

export const getJob = (id: string) => jobs.get(id);
export const listJobs = () => [...jobs.values()];

/** Wait up to `ms` for a job to finish; returns early when it does. */
export async function waitForJob(job: Job, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (job.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
}

export function describeJob(job: Job, logChars = 8_000) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    elapsedSec: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    ...(job.error ? { error: job.error } : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    logTail: tail(job.log, logChars),
  };
}
