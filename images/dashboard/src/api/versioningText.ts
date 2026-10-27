import type { FolderType, Versioning, VersioningType } from "./types.js";

export type VersioningParam = "cleanoutDays" | "keep" | "maxAge" | "command";

export const versioningTypeTexts: Record<VersioningType, string> = {
  "": "none",
  trashcan: "trash can",
  simple: "simple",
  staggered: "staggered",
  external: "external",
};

/** The types a folder can be given here; external only ever comes from the node's own configuration. */
export const offeredVersioningTypes: readonly VersioningType[] = ["", "trashcan", "simple", "staggered"];

/** The params Syncthing reads for each type, by its own names; any other key a folder's `params` holds is left over from an earlier type. */
export const versioningParamKeys: Record<VersioningType, readonly VersioningParam[]> = {
  "": [],
  trashcan: ["cleanoutDays"],
  simple: ["keep", "cleanoutDays"],
  staggered: ["maxAge"],
  external: ["command"],
};

export const versioningParamLabels: Record<VersioningParam, string> = {
  cleanoutDays: "Clean out after (days)",
  keep: "Versions kept",
  maxAge: "Maximum age (days)",
  command: "Command",
};

export const cleanupIntervalLabel = "Cleanup interval";
export const versionsPathLabel = "Versions path";
export const secondsPerDay = 86_400;

/** @implNote Syncthing runs the command itself, without a shell, but any program on the node is still any program: a write from anyone on the tailnet would become code run on the host. */
export const externalVersioningRefusal = "external versioning runs a program on the node, so it is set in the node's own Syncthing configuration, not from the dashboard";

/** Whether Syncthing keeps this type's versions itself, in the versions path, cleaned up on the interval; an external command does neither. */
export function isKeptBySyncthing(type: VersioningType): boolean {
  return type !== "" && type !== "external";
}

function daysText(seconds: string): string {
  const days = Number(seconds) / secondsPerDay;
  const shown = Number.isInteger(days) ? String(days) : days.toFixed(2);
  return `${shown} ${days === 1 ? "day" : "days"}`;
}

function cleanoutText(days: string | undefined): string {
  return days === "0" ? "never cleaned out" : `cleaned out after ${days} ${days === "1" ? "day" : "days"}`;
}

function paramWords(versioning: Versioning): string[] {
  const { params } = versioning;
  if (versioning.type === "trashcan") return [cleanoutText(params.cleanoutDays)];
  if (versioning.type === "simple") return [`${params.keep} versions kept`, cleanoutText(params.cleanoutDays)];
  if (versioning.type === "staggered") return [params.maxAge === "0" ? "versions kept forever" : `versions kept up to ${daysText(params.maxAge ?? "0")}`];
  if (versioning.type === "external") return [`command ${params.command ?? ""}`];
  return [];
}

/** A folder's versioning in words, as the folder detail and Activity name it: `staggered, versions kept up to 365 days, cleanup every 3600 s, in .stversions inside the folder`. */
export function versioningWords(versioning: Versioning): string {
  if (!versioning.type) return "off";
  const kept = isKeptBySyncthing(versioning.type)
    ? [versioning.cleanupIntervalS ? `cleanup every ${versioning.cleanupIntervalS} s` : "no cleanup", `in ${versioning.fsPath || ".stversions inside the folder"}`]
    : [];
  return [versioningTypeTexts[versioning.type], ...paramWords(versioning), ...kept].join(", ");
}

/**
 * What a restore does besides putting the chosen version back, for this folder's versioning and type: how Syncthing keeps the file it
 * replaces, and where the restored file goes.
 * @implNote Syncthing restores only from a versioning it keeps itself, and moves the current file into the versions before putting the
 * old one in its place; a trash can keeps one version of a file, so the current file takes the restored one's place there.
 */
export function restoreConsequences(nodeName: string, folderName: string, versioning: Versioning, folderType: FolderType): string[] {
  const on = `Versioning is on for ${folderName} on ${nodeName} (${versioningWords(versioning)})`;
  const kept = !versioning.type
    ? `Versioning is off for ${folderName} on ${nodeName}, so it keeps no versions to restore.`
    : versioning.type === "trashcan"
      ? `${on}, so Syncthing first moves each current file into the trash can, which keeps only the last version of a file. A file with no current copy is simply put back.`
      : `${on}, so Syncthing first moves each current file into the versions, kept as that versioning keeps versions. A file with no current copy is simply put back.`;
  const spread =
    folderType === "receiveonly"
      ? `${folderName} is receive only on ${nodeName}, so a restored file stays a change made here, which a revert would undo.`
      : `A restored file is a change on ${nodeName}: Syncthing sends it to every device ${folderName} is shared with, replacing their copy.`;
  return [kept, spread];
}
