import { readFile, readdir } from "node:fs/promises";
import type { PresenceWindow } from "./api/types.js";
import type { NodeFile } from "./nodeFile.js";
import { arrayStatusDirectory, arraysStatusDirectory, clusterArrayId, discoveryPollSeconds } from "./settings.js";

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
  /** Set only on an array that is not connected, for a drive the mounter's last round had present. */
  lastPresent?: PresenceWindow | null;
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

/**
 * @implNote The mounter rewrites the status every round while it runs and exits while the cluster's data1
 * is missing, so a status it stopped rewriting still says every drive is present long after they went.
 * A round that rescans every device can take up to the discovery poll, hence the margin above it.
 */
const mounterSilentAfterMilliseconds = (discoveryPollSeconds + 120) * 1000;

function isMounterSilent(status: ArrayStatus, now: number): boolean {
  const updated = Date.parse(status.updated);
  return !Number.isFinite(updated) || now - updated > mounterSilentAfterMilliseconds;
}

function wasPresent(drive: DriveStatus): boolean {
  return drive.condition === "present" || drive.condition === "failing";
}

/**
 * @implNote Only a healthy and complete state dates every member's arrival: a degraded state starts
 * when one drive goes, which says nothing about when the others came.
 */
function lastPresentWindow(status: ArrayStatus): PresenceWindow {
  const everyMemberSince = status.state === "healthy" && status.complete;
  return { since: everyMemberSince ? status.since : status.updated, at: status.updated };
}

function notConnected(status: ArrayStatus): ArrayStatus {
  const detail = `not connected since ${status.updated}`;
  const window = lastPresentWindow(status);
  const drives = status.drives.map((drive): DriveStatus => ({ ...drive, condition: "missing", mounted: false, detail, lastPresent: wasPresent(drive) ? window : null }));
  return { ...status, present: false, complete: false, drives };
}

export async function arrayStatus(arrayId: string, directory = arrayStatusDirectory(arrayId), now = Date.now()): Promise<ArrayStatus | null> {
  try {
    const written = JSON.parse(await readFile(`${directory}/status.json`, "utf8")) as ArrayStatus;
    const status = { ...written, id: written.id ?? arrayId, name: written.name ?? arrayId, present: written.present ?? true };
    return status.present && isMounterSilent(status, now) ? notConnected(status) : status;
  } catch {
    return null;
  }
}

/** The cluster first, then every array the mounter has reported this session. */
export async function arrayIds(): Promise<string[]> {
  const found = await readdir(arraysStatusDirectory).catch(() => [] as string[]);
  return [clusterArrayId, ...found.filter((id) => id !== clusterArrayId).sort()];
}
