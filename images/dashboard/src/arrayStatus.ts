import { readFile, readdir } from "node:fs/promises";
import type { NodeFile } from "./nodeFile.js";
import { arrayStatusDirectory, arraysStatusDirectory, clusterArrayId } from "./settings.js";

export type MounterState = "healthy" | "degraded" | "stopped";
export type DriveCondition = "present" | "dropped" | "missing" | "failing";

export interface DriveStatus {
  label: string;
  role: string;
  condition: DriveCondition;
  detail: string;
  asset: string | null;
  mounted: boolean;
  size: number | null;
  used: number | null;
  serial: string | null;
}

/** The mounter's verdict on one array, written every 10 s to /status/arrays/<id>/status.json. */
export interface ArrayStatus {
  id: string;
  name: string;
  node: string;
  updated: string;
  state: MounterState;
  since: string;
  complete: boolean;
  present: boolean;
  reasons: string[];
  drives: DriveStatus[];
  splitFolders: { id: string; drives: string[] }[];
  pausedFolders: string[];
  description: NodeFile | null;
}

export async function arrayStatus(arrayId: string): Promise<ArrayStatus | null> {
  try {
    const status = JSON.parse(await readFile(`${arrayStatusDirectory(arrayId)}/status.json`, "utf8")) as ArrayStatus;
    return { ...status, id: status.id ?? arrayId, name: status.name ?? arrayId, present: status.present ?? true };
  } catch {
    return null;
  }
}

/** The cluster first, then every array the mounter has reported this session. */
export async function arrayIds(): Promise<string[]> {
  const found = await readdir(arraysStatusDirectory).catch(() => [] as string[]);
  return [clusterArrayId, ...found.filter((id) => id !== clusterArrayId).sort()];
}
