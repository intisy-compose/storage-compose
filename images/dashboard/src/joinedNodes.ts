import { mkdir, rename, writeFile } from "node:fs/promises";
import type { LayeredChange, HandoffResult } from "./api/types.js";
import type { JoinedRound, LayoutRound, NodeFileAction } from "./applyLayout.js";
import { type HandoffContract, handoffResultFile } from "./handoffFeed.js";
import { RequestError } from "./http.js";
import { type IndexEntry } from "./handoffFeed.js";
import { type JoinRecords, type JoinedDevice, isDeviceName } from "./join.js";
import { ReportClient, type JoinedFileRecord, type JoinedFolderReport, type JoinedOp, type ReportedDevice } from "./joinedClient.js";
import type { LocalInstance } from "./instanceResolver.js";
import type { LocalNodeInfo } from "./instanceResolver.js";
import { recordJoinedLayered } from "./layeredDrift.js";
import type { NodePlan } from "./nodePlan.js";
import { handoffDirectory } from "./settings.js";
import type { SetupLayout } from "./setupRepo.js";
import { type SpaceDecision } from "./spacePlan.js";
import { managedIgnoreLines } from "./reconcileNode.js";
import type { WhoIs } from "./tailnet.js";

/** The path a joined device posts its report to and reads its plan and hand-offs from. */
export const joinedLayeredPathPattern = /^\/api\/layered\/node\/([0-9a-f]{4})$/;

export const joinedLayeredSchema = 1;

/** What a joined device sends once per timer round. */
export interface JoinedNodeReport extends ReportedDevice {
  schema: number;
  name: string;
  kind: string;
  threshold: number;
  root: string;
  os: "linux" | "windows";
  space: { totalBytes: number; freeBytes: number } | null;
  result: HandoffResult | null;
}

export interface JoinedNodeAnswer {
  schema: number;
  nodeId: string;
  writtenAt: string;
  admitted: boolean;
  apply: boolean;
  nodeFile: { action: "follow"; policy: { threshold: number; assigned: string[]; access: string } } | { action: "withdraw"; reason: string };
  threshold: number;
  effectiveThreshold: number | null;
  ops: JoinedOp[];
  drift: LayeredChange[];
  problems: string[];
  /** Null for a node that is not planned: its executor has nothing to act on. */
  contract: HandoffContract | null;
}

const maxFolders = 400;
const maxFiles = 400;

function fail(message: string): never {
  throw new RequestError(400, `the report ${message}`);
}

function isText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function isEntry(value: unknown): value is IndexEntry {
  const entry = value as Partial<IndexEntry> | null;
  return typeof entry === "object" && entry !== null && isText(entry.type) && isTextList(entry.version) && isCount(entry.size) && isCount(entry.numBlocks)
    && (typeof entry.blocksHash === "string" || entry.blocksHash === null) && typeof entry.modified === "string" && typeof entry.deleted === "boolean" && typeof entry.ignored === "boolean" && typeof entry.invalid === "boolean";
}

function folderOf(value: unknown): JoinedFolderReport {
  const folder = value as Partial<JoinedFolderReport> | null;
  if (typeof folder !== "object" || folder === null || !isText(folder.id, 256) || !isText(folder.path) || !isText(folder.type, 32) || typeof folder.paused !== "boolean" || !isTextList(folder.devices)) fail("has an unreadable folder");
  if (folder.ignores !== null && !isTextList(folder.ignores)) fail(`has unreadable ignore lines for ${folder.id}`);
  if (folder.status !== null && (typeof folder.status !== "object" || Array.isArray(folder.status))) fail(`has an unreadable status for ${folder.id}`);
  return folder as JoinedFolderReport;
}

function fileOf(value: unknown): JoinedFileRecord {
  const file = value as Partial<JoinedFileRecord> | null;
  if (typeof file !== "object" || file === null || !isText(file.folderId, 256) || !isText(file.path) || !isText(file.modified, 64) || !isEntry(file.entry)) fail("has an unreadable file");
  return file as JoinedFileRecord;
}

function spaceOf(value: unknown): JoinedNodeReport["space"] {
  if (value === null || value === undefined) return null;
  const space = value as Partial<NonNullable<JoinedNodeReport["space"]>>;
  if (!isCount(space.totalBytes) || !isCount(space.freeBytes)) fail("has an unreadable space");
  return { totalBytes: space.totalBytes, freeBytes: space.freeBytes };
}

function resultOf(value: unknown): HandoffResult | null {
  const result = value as Partial<HandoffResult> | null;
  return typeof result === "object" && result !== null && result.schema === 1 && Array.isArray(result.results) && Array.isArray(result.trash) ? (result as HandoffResult) : null;
}

export function parseJoinedReport(body: unknown): JoinedNodeReport {
  const report = body as Partial<JoinedNodeReport> | null;
  if (typeof report !== "object" || report === null || report.schema !== joinedLayeredSchema) fail("is not schema 1");
  if (!isText(report.name, 64) || !isDeviceName(report.name) || !isText(report.deviceId, 128) || !isText(report.root) || !isText(report.kind, 16) || !isCount(report.threshold) || (report.os !== "linux" && report.os !== "windows")) fail("has an unreadable identity");
  if (!isTextList(report.knownDevices) || !Array.isArray(report.folders) || report.folders.length > maxFolders || !Array.isArray(report.files) || report.files.length > maxFiles) fail("has unreadable lists");
  return { schema: report.schema, name: report.name, kind: report.kind, threshold: report.threshold, root: report.root, os: report.os, deviceId: report.deviceId, knownDevices: report.knownDevices, folders: report.folders.map(folderOf), files: report.files.map(fileOf), space: spaceOf(report.space), result: resultOf(report.result) };
}

/** What this dashboard last heard from each joined node, for Requests and its admission. */
const heard = new Map<string, { report: JoinedNodeReport; at: number }>();

/** A report older than this no longer puts a node on Requests: the device has stopped reporting. */
const heardMaxAgeMs = 15 * 60_000;

export function joinedNodeWasHeard(nodeId: string, report: JoinedNodeReport, now: Date): void {
  heard.set(nodeId, { report, at: now.getTime() });
}

/** The joined nodes heard from recently, as `waitingAdmissions` lists them; each has no local Syncthing to address. */
export function joinedNodeInfos(now: Date): LocalNodeInfo[] {
  return [...heard].filter(([, entry]) => now.getTime() - entry.at <= heardMaxAgeMs).map(([nodeId, { report }]) => ({ nodeId, source: "joined", name: report.name, root: report.root, os: report.os, threshold: report.threshold, present: true, remember: false, instance: null }));
}

export function joinedDeviceIdOf(nodeId: string): string | null {
  return heard.get(nodeId)?.report.deviceId ?? null;
}

/** The caller's record, when the node really is its own: a node the layout gives another device, or a device ID not recorded for this caller, is no node of theirs. */
export async function joinedNodeOwner(dependencies: { admit: (addresses: string[]) => Promise<WhoIs>; records: JoinRecords }, addresses: string[], nodeId: string, report: JoinedNodeReport, layout: SetupLayout | null): Promise<JoinedDevice> {
  const caller = await dependencies.admit(addresses).catch(() => null);
  const records = Object.values(await dependencies.records.all());
  const owner = caller?.nodeName ? records.find((device) => device.tailnetName === caller.nodeName && device.syncthingDeviceId === report.deviceId) : undefined;
  const listed = layout?.nodes.find((node) => node.id === nodeId);
  const listedDevice = listed?.device ? layout?.devices.find((device) => device.name === listed.device) : undefined;
  if (!owner || (listedDevice && listedDevice.id !== report.deviceId)) throw new RequestError(404, `no node ${nodeId} of the calling device`);
  return owner;
}

export function joinedInstance(nodeId: string, report: JoinedNodeReport): LocalInstance {
  return { kind: "local", nodeId, name: report.name, client: new ReportClient(report), root: report.root, os: report.os, threshold: report.threshold, source: "joined", reportedSpace: report.space };
}

function nodeFileOf(action: NodeFileAction): JoinedNodeAnswer["nodeFile"] {
  return action.kind === "follow" ? { action: "follow", policy: { threshold: action.policy.threshold, assigned: [...action.policy.assigned], access: action.policy.access } } : { action: "withdraw", reason: action.reason };
}

interface Reconciled {
  plan: NodePlan;
  decision: SpaceDecision | null;
  layout: SetupLayout;
  stopped: boolean;
}

/**
 * Layout devices the plan shares with that the device does not know yet, and the planned folders it does not have, for a node that applies.
 * @implNote A new folder is added send-only: without a size no space decision can let it pull, and a send-only folder takes on what its peers
 * hold only as an index, so the next round's size lets the reconciler turn it send-receive.
 */
function creationOps(report: ReportedDevice, reconciled: Reconciled, closed: ReadonlySet<string>): JoinedOp[] {
  if (reconciled.stopped) return [];
  const { plan, layout } = reconciled;
  const known = new Set([...report.knownDevices, report.deviceId]);
  const existing = new Set(report.folders.map((folder) => folder.id));
  const shareable = (deviceId: string) => !closed.has(deviceId);
  const ops: JoinedOp[] = [];
  const added = new Set<string>();
  for (const folder of plan.folders) {
    for (const deviceId of folder.devices.filter(shareable)) {
      if (known.has(deviceId) || added.has(deviceId)) continue;
      added.add(deviceId);
      ops.push({ op: "addDevice", deviceId, name: layout.devices.find((device) => device.id === deviceId)?.name ?? deviceId.slice(0, 7) });
    }
  }
  for (const folder of plan.folders) {
    if (existing.has(folder.id)) continue;
    const devices = [...new Set([report.deviceId, ...folder.devices.filter(shareable)])];
    ops.push({ op: "addFolder", id: folder.id, label: folder.label, path: folder.path, type: "sendonly", devices, versioning: null, ignores: managedIgnoreLines(folder.ignores) });
  }
  return ops;
}

export interface JoinedLayeredDependencies {
  admit: (addresses: string[]) => Promise<WhoIs>;
  records: JoinRecords;
  layout: () => Promise<SetupLayout | null>;
  round: Pick<LayoutRound, "joinedRound">;
  resultDirectory?: string;
  now?: () => Date;
}

async function keepResult(directory: string, nodeId: string, result: HandoffResult): Promise<void> {
  const path = handoffResultFile(directory, nodeId);
  await mkdir(directory, { recursive: true });
  await writeFile(`${path}.new`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${path}.new`, path);
}

/** @implNote A failed device's report is no reason to fail its plan: the result only feeds the node's page. */
async function answerOf(round: JoinedRound, report: JoinedNodeReport, nodeId: string, client: ReportClient, closed: ReadonlySet<string>, now: Date): Promise<JoinedNodeAnswer> {
  const reconciled = round.reconcile;
  const applies = round.state?.mode === "apply";
  const creations = applies && reconciled ? creationOps(report, reconciled, closed) : [];
  const ops = applies ? [...creations, ...client.ops] : [];
  return {
    schema: joinedLayeredSchema,
    nodeId,
    writtenAt: now.toISOString(),
    admitted: round.state !== null && !round.state.problems.some((problem) => /is not admitted yet/.test(problem)),
    apply: applies,
    nodeFile: nodeFileOf(round.nodeFile),
    threshold: round.state?.threshold ?? 0,
    effectiveThreshold: round.state?.effectiveThreshold ?? null,
    ops,
    drift: round.state?.drift ?? [],
    problems: round.state?.problems ?? [],
    contract: round.contract,
  };
}

/**
 * Answers a joined device's report with its plan, its node file's policy and its hand-off contract.
 * @implNote Only a joined device of this tailnet, for a node that is its own; a node the layout does not list yet is heard for Requests
 * and gets an empty answer, which is how a stick made offline waits for the first online host to commit it.
 */
export async function answerJoinedNode(dependencies: JoinedLayeredDependencies, addresses: string[], nodeId: string, body: unknown): Promise<JoinedNodeAnswer> {
  const now = dependencies.now?.() ?? new Date();
  const report = parseJoinedReport(body);
  const layout = await dependencies.layout();
  await joinedNodeOwner(dependencies, addresses, nodeId, report, layout);
  joinedNodeWasHeard(nodeId, report, now);
  if (report.result) await keepResult(dependencies.resultDirectory ?? handoffDirectory, nodeId, report.result).catch(() => undefined);
  const instance = joinedInstance(nodeId, report);
  const client = instance.client as unknown as ReportClient;
  const round = await dependencies.round.joinedRound(instance);
  const closed = new Set((layout?.devices ?? []).filter((device) => layout?.nodes.some((node) => node.access === "closed" && node.device === device.name)).map((device) => device.id));
  const answer = await answerOf(round, report, nodeId, client, closed, now);
  if (round.state) recordJoinedLayered(nodeId, report.deviceId, round.state);
  return answer;
}
