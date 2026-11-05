import { type NodePlan, keepsFolder } from "./nodePlan.js";
import type { LayoutNode, SetupLayout } from "./setupRepo.js";

/** A file the handing node holds, as its own Syncthing index reports it before any ignore is written. */
export interface LocalFile {
  folderId: string;
  /** Relative to the folder, with `/` between its parts. */
  path: string;
  version: string[];
  size: number;
  blocksHash: string;
  /** ISO 8601. */
  modified: string;
}

/** The record a hand-off is confirmed against; taken first, because once ignored the node's own entry reads size 0 and no hash (phase 0). */
export type HandoffCandidate = LocalFile;

export type KeeperState = "ok" | "degraded" | "stopped" | "frozen";

/** A keeper's own `/rest/db/file` `local` entry. */
export interface KeeperFileEntry {
  version: string[];
  size: number;
  blocksHash: string | null;
  deleted: boolean;
  ignored: boolean;
  invalid: boolean;
}

export interface KeeperFolderReport {
  /** `/rest/db/completion` of the keeper's own folder. */
  completion: number;
  files: Record<string, KeeperFileEntry>;
}

/** What a keeper's host dashboard reports for the files in question. */
export interface KeeperReport {
  nodeId: string;
  online: boolean;
  state: KeeperState;
  /** The keeper's threshold after a raise for space, when it has one. */
  effectiveThreshold?: number;
  folders: Record<string, KeeperFolderReport>;
}

export type WaitingReason = "changed" | "no-keeper" | "keeper-offline" | "not-confirmed";

export type ConfirmedHandoff = HandoffCandidate & { keeper: string };
export type WaitingHandoff = HandoffCandidate & { reason: WaitingReason };

export interface HandoffDecision {
  confirmed: ConfirmedHandoff[];
  waiting: WaitingHandoff[];
}

/** A file changed this recently may still be written to, so it waits (call 11). */
export const handoffQuietMinutes = 10;

const minute = 60_000;

function nodeOf(layout: SetupLayout, nodeId: string): LayoutNode | null {
  return layout.nodes.find((node) => node.id === nodeId) ?? null;
}

function within(ancestor: string, path: string): boolean {
  const ancestorKey = ancestor.toLowerCase();
  const key = path.toLowerCase();
  return ancestorKey === "." || key === ancestorKey || key.startsWith(`${ancestorKey}/`);
}

/** Pinned or assigned anywhere above or at the path, which keeps the file on the node whatever the folder's type. */
function isHeldByPolicy(node: LayoutNode, layoutPath: string): boolean {
  return [...node.assigned, ...Object.keys(node.pins)].some((path) => within(path, layoutPath));
}

function isSettled(file: LocalFile, now: Date, quietMinutes: number): boolean {
  return now.getTime() - Date.parse(file.modified) >= quietMinutes * minute;
}

/**
 * The files the node may hand off: in a folder it only sends because the folder is below its threshold,
 * settled for the quiet period, and not pinned or assigned. None while the node's `apply` is not set.
 */
export function handoffCandidates(layout: SetupLayout, plan: NodePlan, files: LocalFile[], now: Date, quietMinutes = handoffQuietMinutes): HandoffCandidate[] {
  const node = nodeOf(layout, plan.nodeId);
  if (!node?.apply) return [];
  const handing = new Map(plan.folders.filter((folder) => folder.handsOff).map((folder) => [folder.id, folder]));
  return files.filter((file) => {
    const folder = handing.get(file.folderId);
    return folder !== undefined && isSettled(file, now, quietMinutes) && !isHeldByPolicy(node, `${folder.relativePath}/${file.path}`);
  });
}

function sameVersion(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((counter, index) => counter === right[index]);
}

function isUnchanged(candidate: HandoffCandidate, current: LocalFile | undefined): boolean {
  return current !== undefined && sameVersion(candidate.version, current.version) && candidate.size === current.size && candidate.blocksHash === current.blocksHash;
}

/** @implNote Syncthing checks every block's SHA-256 as it writes, so a keeper's own entry at the same version, size and block hash is the checksum check without reading the file again (call 4). */
function confirms(report: KeeperReport, candidate: HandoffCandidate): boolean {
  if (!report.online || report.state !== "ok") return false;
  const folder = report.folders[candidate.folderId];
  const entry = folder?.files[candidate.path];
  if (!folder || folder.completion < 100 || !entry) return false;
  if (entry.deleted || entry.ignored || entry.invalid) return false;
  return sameVersion(entry.version, candidate.version) && entry.size === candidate.size && entry.blocksHash === candidate.blocksHash;
}

function keepersOf(layout: SetupLayout, handingId: string, folderId: string, reports: Map<string, KeeperReport>): LayoutNode[] {
  return layout.nodes.filter((node) => node.id !== handingId && node.enabled && keepsFolder(layout, node.id, folderId, reports.get(node.id)?.effectiveThreshold));
}

function decideOne(layout: SetupLayout, handingId: string, candidate: HandoffCandidate, current: LocalFile | undefined, reports: Map<string, KeeperReport>): ConfirmedHandoff | WaitingHandoff {
  if (!isUnchanged(candidate, current)) return { ...candidate, reason: "changed" };
  const keepers = keepersOf(layout, handingId, candidate.folderId, reports);
  if (keepers.length === 0) return { ...candidate, reason: "no-keeper" };
  const keeper = keepers.find((node) => {
    const report = reports.get(node.id);
    return report !== undefined && confirms(report, candidate);
  });
  if (keeper) return { ...candidate, keeper: keeper.id };
  const anyOnline = keepers.some((node) => reports.get(node.id)?.online);
  return { ...candidate, reason: anyOnline ? "not-confirmed" : "keeper-offline" };
}

function fileKey(file: Pick<LocalFile, "folderId" | "path">): string {
  return `${file.folderId}\n${file.path}`;
}

/**
 * Which candidates may leave the node now: each needs one keeper, a node whose policy keeps the folder,
 * that is online and healthy and reports its own copy complete at the candidate's version, size and
 * block hash, while the node's own file is still that version. Nothing while `apply` is not set.
 */
export function confirmedHandoffs(layout: SetupLayout, nodeId: string, candidates: HandoffCandidate[], current: LocalFile[], keepers: KeeperReport[]): HandoffDecision {
  const decision: HandoffDecision = { confirmed: [], waiting: [] };
  if (!nodeOf(layout, nodeId)?.apply) return decision;
  const reports = new Map(keepers.filter((report) => report.nodeId !== nodeId).map((report) => [report.nodeId, report]));
  const currentByKey = new Map(current.map((file) => [fileKey(file), file]));
  for (const candidate of candidates) {
    const outcome = decideOne(layout, nodeId, candidate, currentByKey.get(fileKey(candidate)), reports);
    if ("keeper" in outcome) decision.confirmed.push(outcome);
    else decision.waiting.push(outcome);
  }
  return decision;
}
