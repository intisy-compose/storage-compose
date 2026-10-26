import type { Versioning, VersioningType } from "./types.js";

export type VersioningParam = "cleanoutDays" | "keep" | "maxAge" | "command";

export const versioningTypeTexts: Record<VersioningType, string> = {
  "": "none",
  trashcan: "trash can",
  simple: "simple",
  staggered: "staggered",
  external: "external",
};

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
