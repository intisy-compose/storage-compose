import { type NodePlan, type PlannedFolder, keepsFolder } from "./nodePlan.js";
import type { LayoutNode, SetupLayout } from "./setupRepo.js";
import type { SpaceDecision } from "./spacePlan.js";

/** A file the handing node holds, as its own Syncthing index reports it before any ignore is written. */
export interface LocalFile {
  folderId: string;
  /** Relative to the folder; `\` is read as `/`. */
  path: string;
  /** Syncthing's entry type, `FILE_INFO_TYPE_FILE` for a file. */
  type: string;
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
  type: string;
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
  /** By path relative to the folder. */
  files: Record<string, KeeperFileEntry>;
}

/** What a keeper's host dashboard reported for the files in question. */
export interface KeeperReport {
  nodeId: string;
  online: boolean;
  state: KeeperState;
  /** When this host read the report, ISO 8601. */
  observedAt: string;
  /** The keeper's threshold after any raise for space; never below its committed one. */
  effectiveThreshold: number;
  folders: Record<string, KeeperFolderReport>;
}

export type WaitingReason = "changed" | "held" | "no-keeper" | "keeper-offline" | "not-confirmed";

export type ConfirmedHandoff = HandoffCandidate & { keeper: string };
export type WaitingHandoff = HandoffCandidate & { reason: WaitingReason };

export interface HandoffDecision {
  confirmed: ConfirmedHandoff[];
  waiting: WaitingHandoff[];
}

/** A file changed this recently may still be written to, so it waits (call 11). */
export const handoffQuietMinutes = 10;

/**
 * A keeper report older than this counts as offline.
 * @implNote A confirmation stands for the keeper's state now: an older report could predate a freeze (C-24), a deletion or a lost drive on the keeper, and two minutes still covers one read through a peer dashboard with its timeouts.
 */
export const keeperReportMaxAgeSeconds = 120;

const minute = 60_000;

function nodeOf(layout: SetupLayout, nodeId: string): LayoutNode | null {
  return layout.nodes.find((node) => node.id === nodeId) ?? null;
}

export function normaliseFilePath(path: string): string {
  return path.split(/[\\/]+/).filter((segment) => segment !== "").join("/");
}

function within(ancestor: string, path: string): boolean {
  const ancestorKey = normaliseFilePath(ancestor).toLowerCase();
  const key = normaliseFilePath(path).toLowerCase();
  return ancestorKey === "" || ancestorKey === "." || key === ancestorKey || key.startsWith(`${ancestorKey}/`);
}

/** Pinned or assigned anywhere above or at the path, which keeps the file on the node whatever the folder's type. */
function isHeldByPolicy(node: LayoutNode, layoutPath: string): boolean {
  return [...node.assigned, ...Object.keys(node.pins)].some((path) => within(path, layoutPath));
}

function isSettled(file: LocalFile, now: Date, quietMinutes: number): boolean {
  return now.getTime() - Date.parse(file.modified) >= quietMinutes * minute;
}

function hasHash(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && hash !== "";
}

/** A record a keeper can be compared with: a finite size, a block hash and a version. */
function isComparable(file: LocalFile): boolean {
  return Number.isFinite(file.size) && hasHash(file.blocksHash) && file.version.length > 0;
}

/** No hand-off at all from a node that only reports, is not enabled, has a blocking layout problem, or whose space decision is stopped or unknown. */
function mayHandOff(node: LayoutNode | null, plan: NodePlan, decision: SpaceDecision): node is LayoutNode {
  return node !== null && node.apply && node.enabled && plan.problems.length === 0 && decision.handoffAllowed;
}

/** The folder that hands the file off, unless policy holds the file on the node. */
function handingFolder(node: LayoutNode, plan: NodePlan, file: LocalFile): PlannedFolder | null {
  const folder = plan.folders.find((entry) => entry.id === file.folderId && entry.handsOff);
  if (!folder || isHeldByPolicy(node, `${folder.relativePath}/${file.path}`)) return null;
  return folder;
}

/**
 * The files the node may hand off: in a folder it only sends because the folder is below its threshold,
 * settled for the quiet period, comparable, and not pinned or assigned.
 */
export function handoffCandidates(layout: SetupLayout, plan: NodePlan, files: LocalFile[], decision: SpaceDecision, now: Date, quietMinutes = handoffQuietMinutes): HandoffCandidate[] {
  const node = nodeOf(layout, plan.nodeId);
  if (!mayHandOff(node, plan, decision)) return [];
  return files
    .map((file) => ({ ...file, path: normaliseFilePath(file.path) }))
    .filter((file) => isComparable(file) && isSettled(file, now, quietMinutes) && handingFolder(node, plan, file) !== null);
}

function sameVersion(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((counter, index) => counter === right[index]);
}

function isUnchanged(candidate: HandoffCandidate, current: LocalFile | undefined): boolean {
  return current !== undefined && isComparable(current) && current.type === candidate.type && sameVersion(candidate.version, current.version) && candidate.size === current.size && candidate.blocksHash === current.blocksHash;
}

function isFresh(report: KeeperReport, now: Date, maxAgeSeconds: number): boolean {
  const observed = Date.parse(report.observedAt);
  return Number.isFinite(observed) && Math.abs(now.getTime() - observed) <= maxAgeSeconds * 1000;
}

function entryAt(folder: KeeperFolderReport, path: string): KeeperFileEntry | undefined {
  return Object.entries(folder.files).find(([key]) => normaliseFilePath(key) === path)?.[1];
}

/** @implNote Syncthing checks every block's SHA-256 as it writes, so a keeper's own entry at the same type, version, size and block hash is the checksum check without reading the file again (call 4). */
function confirms(report: KeeperReport, candidate: HandoffCandidate): boolean {
  if (report.state !== "ok") return false;
  const folder = report.folders[candidate.folderId];
  if (!folder || !(folder.completion >= 100)) return false;
  const entry = entryAt(folder, candidate.path);
  if (!entry || entry.deleted || entry.ignored || entry.invalid) return false;
  if (!Number.isFinite(entry.size) || !hasHash(entry.blocksHash)) return false;
  return entry.type === candidate.type && sameVersion(entry.version, candidate.version) && entry.size === candidate.size && entry.blocksHash === candidate.blocksHash;
}

function deviceIdOf(layout: SetupLayout, node: LayoutNode): string {
  return layout.devices.find((device) => device.name === node.device)?.id ?? "";
}

/** @implNote A node on the handing node's own device is the same Syncthing identity, so it can never be a second copy. */
function isOtherDevice(layout: SetupLayout, handing: LayoutNode, node: LayoutNode): boolean {
  if (node.device === handing.device) return false;
  const handingId = deviceIdOf(layout, handing);
  return handingId === "" || deviceIdOf(layout, node) !== handingId;
}

function keepersOf(layout: SetupLayout, handing: LayoutNode, folderId: string, reports: Map<string, KeeperReport>): LayoutNode[] {
  return layout.nodes.filter((node) => {
    if (node.id === handing.id || !node.enabled || !isOtherDevice(layout, handing, node)) return false;
    const reported = reports.get(node.id)?.effectiveThreshold ?? node.threshold;
    return keepsFolder(layout, node.id, folderId, Math.max(node.threshold, reported));
  });
}

interface Judgement {
  layout: SetupLayout;
  handing: LayoutNode;
  plan: NodePlan;
  reports: Map<string, KeeperReport>;
}

function decideOne(judgement: Judgement, candidate: HandoffCandidate, current: LocalFile | undefined): ConfirmedHandoff | WaitingHandoff {
  if (handingFolder(judgement.handing, judgement.plan, candidate) === null) return { ...candidate, reason: "held" };
  if (!isUnchanged(candidate, current)) return { ...candidate, reason: "changed" };
  const keepers = keepersOf(judgement.layout, judgement.handing, candidate.folderId, judgement.reports);
  if (keepers.length === 0) return { ...candidate, reason: "no-keeper" };
  const keeper = keepers.find((node) => {
    const report = judgement.reports.get(node.id);
    return report !== undefined && confirms(report, candidate);
  });
  if (keeper) return { ...candidate, keeper: keeper.id };
  const anyOnline = keepers.some((node) => judgement.reports.has(node.id));
  return { ...candidate, reason: anyOnline ? "not-confirmed" : "keeper-offline" };
}

function fileKey(file: Pick<LocalFile, "folderId" | "path">): string {
  return `${file.folderId}\n${normaliseFilePath(file.path)}`;
}

/** The online, fresh reports by node; a node reported twice is refused, since either report could be the stale one. */
function reportsByNode(keepers: KeeperReport[], handingId: string, now: Date, maxAgeSeconds: number): Map<string, KeeperReport> {
  const seen = new Set<string>();
  for (const report of keepers) {
    if (seen.has(report.nodeId)) throw new Error(`two keeper reports for node ${report.nodeId}`);
    seen.add(report.nodeId);
  }
  return new Map(keepers.filter((report) => report.nodeId !== handingId && report.online && isFresh(report, now, maxAgeSeconds)).map((report) => [report.nodeId, report]));
}

/**
 * Which candidates may leave the node now: each needs one keeper, an enabled node on another device whose
 * policy keeps the folder, that is online, healthy, reported within `maxReportAgeSeconds`, and has its own
 * copy complete at the candidate's type, version, size and block hash, while the node's own file is
 * still that version and still a candidate under the plan.
 */
export function confirmedHandoffs(
  layout: SetupLayout,
  plan: NodePlan,
  candidates: HandoffCandidate[],
  current: LocalFile[],
  keepers: KeeperReport[],
  decision: SpaceDecision,
  now: Date,
  maxReportAgeSeconds = keeperReportMaxAgeSeconds,
): HandoffDecision {
  const result: HandoffDecision = { confirmed: [], waiting: [] };
  const handing = nodeOf(layout, plan.nodeId);
  if (!mayHandOff(handing, plan, decision)) return result;
  const judgement: Judgement = { layout, handing, plan, reports: reportsByNode(keepers, plan.nodeId, now, maxReportAgeSeconds) };
  const currentByKey = new Map(current.map((file) => [fileKey(file), file]));
  for (const candidate of candidates) {
    const outcome = decideOne(judgement, { ...candidate, path: normaliseFilePath(candidate.path) }, currentByKey.get(fileKey(candidate)));
    if ("keeper" in outcome) result.confirmed.push(outcome);
    else result.waiting.push(outcome);
  }
  return result;
}
