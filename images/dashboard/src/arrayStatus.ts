import { readFile } from "node:fs/promises";
import { statusDirectory } from "./settings.js";

export type ArrayState = "healthy" | "degraded" | "stopped";
export type DriveCondition = "present" | "dropped" | "missing" | "failing";

export interface DriveStatus {
  label: string;
  role: string;
  condition: DriveCondition;
  detail: string;
  asset: string | null;
}

export interface SplitFolder {
  id: string;
  drives: string[];
}

/** The mounter's verdict, written every 10 s to status.json. */
export interface ArrayStatus {
  updated: string;
  state: ArrayState;
  since: string;
  complete: boolean;
  reasons: string[];
  drives: DriveStatus[];
  splitFolders: SplitFolder[];
  pausedFolders: string[];
}

export async function arrayStatus(): Promise<ArrayStatus | null> {
  try {
    return JSON.parse(await readFile(`${statusDirectory}/status.json`, "utf8")) as ArrayStatus;
  } catch {
    return null;
  }
}
