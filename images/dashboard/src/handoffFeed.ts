import { mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arrayStatus } from "./arrayStatus.js";
import { agentEntries, readHeartbeat } from "./hostAgent.js";
import {
  type HandoffDecision,
  type KeeperFileEntry,
  type KeeperReport,
  type KeeperState,
  type LocalFile,
  type WaitingReason,
  confirmedHandoffs,
  handoffCandidates,
  handoffQuietMinutes,
  normaliseFilePath,
} from "./handoffPlan.js";
import { type LocalInstance, callSyncthing } from "./instanceResolver.js";
import { type NodePlan, type PlannedFolder, keepsFolder, nodePlan } from "./nodePlan.js";
import { handoffDirectory, handoffSettings, hostAgentHandoffDirectory, hostAgentHeartbeatFile } from "./settings.js";
import type { LayoutNode, SetupLayout } from "./setupRepo.js";
import { SyncthingRefusal } from "./syncthing.js";
import { type FolderSize, type FolderSizes, type NodeSpace, effectiveThreshold } from "./spacePlan.js";

export const handoffContractSchema = 1;

/**
 * At most this many files per node and round are read and offered.
 * @implNote Each costs one `/rest/db/file` on the node and one on every keeper, twice for the node; a folder of a hundred thousand files is
 * handed off over many rounds instead of holding up the layout round that also reconciles every other node.
 */
export const handoffBatchSize = 200;

/** One file the executor may hand off, with the record a keeper confirmed, taken from the node's own index before any ignore. */
export interface HandoffContractEntry {
  folderId: string;
  /** The folder's path on the node as the plan has it; the executor acts only where its own Syncthing has the folder at this path. */
  folderPath: string;
  /** Relative to the folder, `/` separated. */
  path: string;
  type: string;
  version: string[];
  size: number;
  /** With `size`, gives the block size the executor hashes with. */
  numBlocks: number;
  /** Base64 SHA-256 over the SHA-256 of each block, as Syncthing computes it. */
  blocksHash: string;
  /** As Syncthing reports it, nanoseconds and offset included. */
  modified: string;
  /** `modified` in whole Unix seconds, the precision both executors compare at. */
  modifiedSeconds: number;
  keeper: string;
  /** The keeper's Syncthing device ID, which the node's own index must list as holding this version. */
  keeperDevice: string;
}

export interface HandoffWaiting {
  folderId: string;
  path: string;
  reason: WaitingReason;
}

/** `/status/handoff/<node id>.json`, replaced whole every round. */
export interface HandoffContract {
  schema: typeof handoffContractSchema;
  nodeId: string;
  writtenAt: string;
  apply: boolean;
  cluster: boolean;
  quietMinutes: number;
  entries: HandoffContractEntry[];
  waiting: HandoffWaiting[];
  notes: string[];
}

/** A node's own `/rest/db/file` `local` entry, or a keeper's. */
export interface IndexEntry {
  type: string;
  version: string[];
  size: number;
  numBlocks: number;
  blocksHash: string | null;
  modified: string;
  deleted: boolean;
  ignored: boolean;
  invalid: boolean;
}

/** What deciding a contract reads from this host's Syncthing instances, and nothing else: it never writes to any. */
export interface HandoffReads {
  /** Every file of the folder's tree with its modification time, as `/rest/db/browse` lists it. */
  files(instance: LocalInstance, folderId: string): Promise<{ path: string; modified: string }[]>;
  entry(instance: LocalInstance, folderId: string, path: string): Promise<IndexEntry | null>;
  completion(instance: LocalInstance, folderId: string): Promise<number>;
  sizes(instance: LocalInstance, folderId: string): Promise<FolderSize>;
  /** Null when the node's space cannot be read. */
  space(instance: LocalInstance): Promise<NodeSpace | null>;
  keeperState(instance: LocalInstance): Promise<KeeperState>;
}

export interface HandoffInput {
  layout: SetupLayout;
  nodeId: string;
  /** The layout paths the node holds, as `carriedLayoutPaths` gives them for its plan. */
  localFolders: ReadonlySet<string>;
  instance: LocalInstance;
  /** Every Syncthing instance of this host; the others are the keepers that can be read. */
  instances: LocalInstance[];
  reads: HandoffReads;
  /** This host's clock: candidates are taken, keepers stamped and the decision made by it. */
  now: () => Date;
  quietMinutes?: number;
  batch?: number;
}

const isoTime = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Whole Unix seconds of an RFC 3339 time, rounded down; null when it is not one. */
export function modifiedSecondsOf(modified: string): number | null {
  const match = isoTime.exec(modified);
  if (!match) return null;
  const whole = Date.parse(`${match[1]}${match[3]}`);
  return Number.isFinite(whole) ? whole / 1000 : null;
}

export function emptyContract(nodeId: string, apply: boolean, cluster: boolean, now: Date, quietMinutes = handoffQuietMinutes): HandoffContract {
  return { schema: handoffContractSchema, nodeId, writtenAt: now.toISOString(), apply, cluster, quietMinutes, entries: [], waiting: [], notes: [] };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRecord(entry: IndexEntry | null): entry is IndexEntry & { blocksHash: string } {
  return entry !== null && entry.type === "FILE_INFO_TYPE_FILE" && !entry.deleted && !entry.ignored && !entry.invalid && typeof entry.blocksHash === "string" && entry.blocksHash !== "" && entry.version.length > 0;
}

function localFileOf(folderId: string, path: string, entry: IndexEntry & { blocksHash: string }): LocalFile {
  return { folderId, path, type: entry.type, version: [...entry.version], size: entry.size, blocksHash: entry.blocksHash, modified: entry.modified };
}

function fileKey(folderId: string, path: string): string {
  return `${folderId}\n${normaliseFilePath(path)}`;
}

function isQuiet(modified: string, now: Date, quietMinutes: number): boolean {
  return now.getTime() - Date.parse(modified) >= quietMinutes * 60_000;
}

/** The node's own records of up to `batch` settled files of its hand-off folders, read from its index while no ignore names them. */
async function ownRecords(input: HandoffInput, folders: PlannedFolder[], quietMinutes: number): Promise<{ files: LocalFile[]; entries: Map<string, IndexEntry> }> {
  const batch = input.batch ?? handoffBatchSize;
  const files: LocalFile[] = [];
  const entries = new Map<string, IndexEntry>();
  for (const folder of folders) {
    for (const listed of await input.reads.files(input.instance, folder.id)) {
      if (files.length >= batch) return { files, entries };
      if (!isQuiet(listed.modified, input.now(), quietMinutes)) continue;
      const entry = await input.reads.entry(input.instance, folder.id, listed.path);
      if (!hasRecord(entry)) continue;
      files.push(localFileOf(folder.id, listed.path, entry));
      entries.set(fileKey(folder.id, listed.path), entry);
    }
  }
  return { files, entries };
}

async function folderSizes(input: HandoffInput, plan: NodePlan): Promise<FolderSizes> {
  const sizes: FolderSizes = {};
  for (const folder of plan.folders) sizes[folder.id] = await input.reads.sizes(input.instance, folder.id);
  return sizes;
}

function keeperEntryOf(entry: IndexEntry | null): KeeperFileEntry | null {
  if (!entry) return null;
  return { type: entry.type, version: [...entry.version], size: entry.size, blocksHash: entry.blocksHash, deleted: entry.deleted, ignored: entry.ignored, invalid: entry.invalid };
}

/**
 * A keeper's report on the candidates of the folders it keeps, read straight from its Syncthing on this host.
 * @implNote `observedAt` is stamped from this host's clock once every read has returned, as `KeeperReport` asks; a keeper of another
 * host is not read at all, since a report relayed through its dashboard would carry no age of its own.
 */
async function keeperReport(input: HandoffInput, keeper: LocalInstance, node: LayoutNode, candidates: LocalFile[]): Promise<KeeperReport | null> {
  try {
    const folders: KeeperReport["folders"] = {};
    for (const folderId of new Set(candidates.map((candidate) => candidate.folderId))) {
      if (!keepsFolder(input.layout, node.id, folderId)) continue;
      const files: Record<string, KeeperFileEntry> = {};
      for (const candidate of candidates.filter((entry) => entry.folderId === folderId)) {
        const found = keeperEntryOf(await input.reads.entry(keeper, folderId, candidate.path));
        if (found) files[candidate.path] = found;
      }
      folders[folderId] = { completion: await input.reads.completion(keeper, folderId), files };
    }
    const state = await input.reads.keeperState(keeper);
    return { nodeId: node.id, online: true, state, observedAt: input.now().toISOString(), effectiveThreshold: node.threshold, folders };
  } catch {
    return null;
  }
}

async function keeperReports(input: HandoffInput, candidates: LocalFile[]): Promise<KeeperReport[]> {
  const reports: KeeperReport[] = [];
  for (const keeper of input.instances.filter((candidate) => candidate.nodeId !== input.nodeId)) {
    const node = input.layout.nodes.find((entry) => entry.id === keeper.nodeId);
    if (!node) continue;
    const report = await keeperReport(input, keeper, node, candidates);
    if (report) reports.push(report);
  }
  return reports;
}

/** The node's own entries once more, after the keepers were read, so a file changed meanwhile is caught by `confirmedHandoffs`. */
async function currentFiles(input: HandoffInput, candidates: LocalFile[]): Promise<LocalFile[]> {
  const current: LocalFile[] = [];
  for (const candidate of candidates) {
    const entry = await input.reads.entry(input.instance, candidate.folderId, candidate.path);
    if (entry && !entry.deleted && typeof entry.blocksHash === "string") current.push(localFileOf(candidate.folderId, candidate.path, { ...entry, blocksHash: entry.blocksHash }));
  }
  return current;
}

function deviceOfNode(layout: SetupLayout, nodeId: string): string {
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  return layout.devices.find((device) => device.name === node?.device)?.id ?? "";
}

function entriesOf(layout: SetupLayout, plan: NodePlan, decision: HandoffDecision, records: Map<string, IndexEntry>): HandoffContractEntry[] {
  return decision.confirmed.flatMap((confirmed) => {
    const record = records.get(fileKey(confirmed.folderId, confirmed.path));
    const folder = plan.folders.find((entry) => entry.id === confirmed.folderId);
    const modifiedSeconds = modifiedSecondsOf(confirmed.modified);
    const keeperDevice = deviceOfNode(layout, confirmed.keeper);
    if (!record || !folder || modifiedSeconds === null || !keeperDevice || !Number.isInteger(record.numBlocks)) return [];
    return [{
      folderId: confirmed.folderId,
      folderPath: folder.path,
      path: confirmed.path,
      type: confirmed.type,
      version: confirmed.version,
      size: confirmed.size,
      numBlocks: record.numBlocks,
      blocksHash: confirmed.blocksHash,
      modified: confirmed.modified,
      modifiedSeconds,
      keeper: confirmed.keeper,
      keeperDevice,
    }];
  });
}

/** The plan at the threshold the space decision allows, or null with the reason when nothing may leave the node. */
async function plannedForSpace(input: HandoffInput, plan: NodePlan): Promise<{ plan: NodePlan; decision: ReturnType<typeof effectiveThreshold> } | { note: string }> {
  const space = await input.reads.space(input.instance);
  if (!space) return { note: "the node's space cannot be read, so nothing is handed off" };
  const decision = effectiveThreshold(plan, await folderSizes(input, plan), space);
  if (!decision.handoffAllowed) return { note: `the node's space decision is ${decision.state}, so nothing is handed off` };
  const raised = decision.threshold === plan.appliedThreshold ? plan : nodePlan(input.layout, input.nodeId, input.localFolders, decision.threshold);
  return raised ? { plan: raised, decision } : { note: "the node has no plan at the raised threshold" };
}

/**
 * The node's contract for this round: the files a keeper has confirmed, each with the record taken from the node's own index before any
 * ignore names it (phase 0: once ignored, the node's entry reads size 0 and no hash). Empty for a node that only reports, the cluster,
 * a node blocked by the layout and whenever the space decision allows no hand-off.
 */
export async function decideHandoffContract(input: HandoffInput): Promise<HandoffContract> {
  const quietMinutes = input.quietMinutes ?? handoffQuietMinutes;
  const node = input.layout.nodes.find((entry) => entry.id === input.nodeId);
  const plan = node ? nodePlan(input.layout, input.nodeId, input.localFolders) : null;
  const contract = emptyContract(input.nodeId, node?.apply ?? false, plan?.cluster ?? false, input.now(), quietMinutes);
  if (!node || !plan || !node.apply || !node.enabled || plan.cluster || plan.problems.length || !plan.admitted) return contract;
  try {
    const placed = await plannedForSpace(input, plan);
    if ("note" in placed) return { ...contract, notes: [placed.note] };
    const handing = placed.plan.folders.filter((folder) => folder.handsOff);
    const own = await ownRecords(input, handing, quietMinutes);
    const candidates = handoffCandidates(input.layout, placed.plan, own.files, placed.decision, input.now(), quietMinutes);
    if (candidates.length === 0) return contract;
    const reports = await keeperReports(input, candidates);
    const current = await currentFiles(input, candidates);
    const decision = confirmedHandoffs(input.layout, placed.plan, candidates, current, reports, placed.decision, input.now());
    return {
      ...contract,
      entries: entriesOf(input.layout, placed.plan, decision, own.entries),
      waiting: decision.waiting.map((waiting) => ({ folderId: waiting.folderId, path: waiting.path, reason: waiting.reason })),
      notes: decision.notes,
    };
  } catch (error) {
    return { ...contract, notes: [`${node.name} does not answer: ${reasonOf(error)}`] };
  }
}

/** Replaced in one rename, so an executor never reads half a contract. */
export async function writeHandoffContract(path: string, contract: HandoffContract): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, `${JSON.stringify(contract, null, 2)}\n`);
  await rename(`${path}.new`, path);
}

export async function readHandoffContract(path: string): Promise<HandoffContract | null> {
  try {
    const contract = JSON.parse(await readFile(path, "utf8")) as HandoffContract;
    return contract && contract.schema === handoffContractSchema && Array.isArray(contract.entries) ? contract : null;
  } catch {
    return null;
  }
}

export function handoffContractFile(directory: string, nodeId: string): string {
  return join(directory, `${nodeId}.json`);
}

export function handoffResultFile(directory: string, nodeId: string): string {
  return join(directory, `${nodeId}.result.json`);
}

interface BrowseEntry {
  name: string;
  type: string;
  modTime: string;
  children?: BrowseEntry[];
}

function browsedFiles(entries: BrowseEntry[] | null, prefix = ""): { path: string; modified: string }[] {
  return (entries ?? []).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.children || entry.type === "FILE_INFO_TYPE_DIRECTORY" || entry.type === "directory") return browsedFiles(entry.children ?? [], path);
    return entry.type === "FILE_INFO_TYPE_FILE" || entry.type === "file" ? [{ path, modified: entry.modTime }] : [];
  });
}

function query(folderId: string, path?: string): string {
  return `folder=${encodeURIComponent(folderId)}${path === undefined ? "" : `&file=${encodeURIComponent(path)}`}`;
}

/** @implNote A space read through the host agent's heartbeat for a Windows node, `statfs` of its root for one whose files this host mounts. */
async function nodeSpace(instance: LocalInstance): Promise<NodeSpace | null> {
  if (instance.os === "windows") {
    const entry = agentEntries(await readHeartbeat(hostAgentHeartbeatFile)).find((candidate) => candidate.id === instance.nodeId);
    const { size, used } = entry?.space ?? { size: null, used: null };
    return size !== null && used !== null ? { totalBytes: size, freeBytes: size - used } : null;
  }
  if (!instance.root) return null;
  try {
    const stats = await statfs(instance.root);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

/** An array keeper is what its mounter says: degraded or stopped as such, frozen while any of its folders is paused for C-24. */
async function keeperStateOf(instance: LocalInstance): Promise<KeeperState> {
  if (instance.source !== "array") return "ok";
  const status = await arrayStatus(instance.nodeId);
  if (!status || !status.present || status.state === "stopped") return "stopped";
  if (status.pausedFolders.length > 0) return "frozen";
  return status.state === "degraded" ? "degraded" : "ok";
}

/** The reads of each instance's own Syncthing, as the layout round makes them. */
export const syncthingHandoffReads: HandoffReads = {
  files: async (instance, folderId) => browsedFiles(await callSyncthing(instance, (client) => client.request<BrowseEntry[] | null>("GET", `/db/browse?${query(folderId)}`))),
  entry: async (instance, folderId, path) => {
    try {
      return (await callSyncthing(instance, (client) => client.request<{ local?: IndexEntry } | null>("GET", `/db/file?${query(folderId, path)}`)))?.local ?? null;
    } catch (error) {
      if (error instanceof SyncthingRefusal && error.status === 404) return null;
      throw error;
    }
  },
  completion: async (instance, folderId) => (await callSyncthing(instance, (client) => client.request<{ completion: number }>("GET", `/db/completion?${query(folderId)}`))).completion,
  sizes: async (instance, folderId) => {
    const status = await callSyncthing(instance, (client) => client.request<{ globalBytes: number; localBytes: number }>("GET", `/db/status?${query(folderId)}`));
    return { globalBytes: status.globalBytes, localBytes: status.localBytes };
  },
  space: nodeSpace,
  keeperState: keeperStateOf,
};

/** The folder the node's executor reads its contract from: the host agent's own mount for a Windows node, the status volume otherwise. */
export function handoffDirectoryOf(instance: LocalInstance): string {
  return instance.source === "host-agent" ? hostAgentHandoffDirectory : handoffDirectory;
}

export interface PublishContext {
  layout: SetupLayout;
  nodeId: string;
  localFolders: ReadonlySet<string>;
  instance: LocalInstance;
  instances: LocalInstance[];
}

export interface HandoffPublisher {
  /** Writes the node's contract for this round, an empty one included, and returns how many files it names and waits for; null in report mode. */
  publish(context: PublishContext): Promise<number | null>;
  /** The empty contract, for a round that could not plan the node, so no older one stays for its executor. */
  clear(nodeId: string, instance: LocalInstance, apply: boolean): Promise<void>;
}

const published = new Map<string, HandoffContract>();

/** The contract this host last wrote for the node, null when it wrote none. */
export function publishedContract(nodeId: string): HandoffContract | null {
  return published.get(nodeId) ?? null;
}

export function handoffPublisher(
  reads: HandoffReads = syncthingHandoffReads,
  directoryOf: (instance: LocalInstance) => string = handoffDirectoryOf,
  now: () => Date = () => new Date(),
  quietMinutes = handoffSettings.quietMinutes,
): HandoffPublisher {
  const write = async (instance: LocalInstance, contract: HandoffContract) => {
    await writeHandoffContract(handoffContractFile(directoryOf(instance), contract.nodeId), contract);
    published.set(contract.nodeId, contract);
  };
  return {
    publish: async (context) => {
      const contract = await decideHandoffContract({ ...context, reads, now, quietMinutes });
      await write(context.instance, contract);
      return contract.apply ? contract.entries.length + contract.waiting.length : null;
    },
    clear: (nodeId, instance, apply) => write(instance, emptyContract(nodeId, apply, false, now(), quietMinutes)),
  };
}
