import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stateDirectory, statusDirectory } from "./settings.js";

export type Job =
  | { kind: "sync"; anyway: boolean }
  | { kind: "scrub" }
  | { kind: "rebuild"; role: string; device: string }
  | { kind: "remove"; role: string };

const runningMarker = `${statusDirectory}/snapraid.job.name`;
const logLinesShown = 60;

function jobArguments(job: Job): string[] {
  switch (job.kind) {
    case "sync":
      return job.anyway ? ["sync", "--anyway"] : ["sync"];
    case "scrub":
      return ["scrub"];
    case "rebuild":
      return ["rebuild", job.role, job.device];
    case "remove":
      return ["remove", job.role];
  }
}

export function isJobRunning(): boolean {
  return existsSync(runningMarker);
}

/** @implNote Detached, so a rebuild that takes hours outlives the request that started it. */
export function startJob(job: Job): void {
  const child = spawn("snapraid.sh", ["run", ...jobArguments(job)], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function parityStatus(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(`${statusDirectory}/snapraid.json`, "utf8"));
  } catch {
    return null;
  }
}

export async function recentLog(): Promise<string[]> {
  try {
    const lines = (await readFile(`${stateDirectory}/log/snapraid.log`, "utf8")).split("\n").filter(Boolean);
    return lines.slice(-logLinesShown);
  } catch {
    return [];
  }
}
