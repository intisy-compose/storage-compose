import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Parity, ParityJob } from "./api/types.js";
import { arrayStateDirectory, arrayStatusDirectory } from "./settings.js";

export type Job =
  | { kind: "sync"; anyway: boolean }
  | { kind: "scrub" }
  | { kind: "add"; device: string }
  | { kind: "rebuild"; role: string; device: string }
  | { kind: "remove"; role: string };

interface SchedulerStatus {
  lastSync: number;
  lastSyncResult: string;
  lastScrub: number;
  lastScrubResult: string;
  refused: string;
}

const logLinesShown = 200;

function jobArguments(job: Job): string[] {
  switch (job.kind) {
    case "sync":
      return job.anyway ? ["sync", "--anyway"] : ["sync"];
    case "scrub":
      return ["scrub"];
    case "add":
      return ["add", job.device];
    case "rebuild":
      return ["rebuild", job.role, job.device];
    case "remove":
      return ["remove", job.role];
  }
}

export function isJobRunning(arrayId: string): boolean {
  return existsSync(`${arrayStatusDirectory(arrayId)}/snapraid.job.name`);
}

/** @implNote Detached, so a rebuild that takes hours outlives the request that started it. */
export function startJob(arrayId: string, job: Job): void {
  const child = spawn("snapraid.sh", ["--array", arrayId, "run", ...jobArguments(job)], { detached: true, stdio: "ignore" });
  child.unref();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function isoFromEpoch(seconds: number | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}


const runFreshMilliseconds = 30_000;

async function freshModified(path: string): Promise<Date | null> {
  const info = await stat(path).catch(() => null);
  return info && Date.now() - info.mtimeMs < runFreshMilliseconds ? info.mtime : null;
}

/**
 * A SnapRAID run seen through the wrapper in front of it, whoever started it, or else a job of
 * snapraid.sh between two runs (formatting a replacement, say).
 */
export async function runningJob(arrayId: string): Promise<ParityJob | null> {
  const directory = arrayStatusDirectory(arrayId);
  if (await freshModified(`${directory}/snapraid.run.json`)) {
    const run = await readJson<{ kind: string; startedAt: string }>(`${directory}/snapraid.run.json`);
    const progress = Number((await readFile(`${directory}/snapraid.progress`, "utf8").catch(() => "0")).trim()) || 0;
    if (run) return { kind: run.kind, progress, startedAt: run.startedAt };
  }
  const jobFile = `${directory}/snapraid.job.name`;
  const name = (await readFile(jobFile, "utf8").catch(() => "")).trim();
  if (!name) return null;
  const started = await stat(jobFile).then((info) => info.mtime.toISOString()).catch(() => new Date().toISOString());
  return { kind: name.split(" ")[0], progress: 0, startedAt: started };
}

export async function parityState(arrayId: string): Promise<Parity> {
  const status = await readJson<SchedulerStatus>(`${arrayStatusDirectory(arrayId)}/snapraid.json`);
  return {
    job: await runningJob(arrayId),
    lastSync: isoFromEpoch(status?.lastSync),
    lastScrub: isoFromEpoch(status?.lastScrub),
    refused: status?.refused || null,
    lastSyncResult: status?.lastSyncResult || null,
    lastScrubResult: status?.lastScrubResult || null,
  };
}

export async function recentLog(arrayId: string): Promise<string[]> {
  try {
    const lines = (await readFile(`${arrayStateDirectory(arrayId)}/log/snapraid.log`, "utf8")).split("\n").filter(Boolean);
    return lines.slice(-logLinesShown);
  } catch {
    return [];
  }
}
