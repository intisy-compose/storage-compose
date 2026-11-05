import { deviceDisplayName } from "./api/deviceText.js";
import { type FolderCopy, type FolderDetailResponse, type FolderLayered, type FolderSettings, type FolderSummary, type FoldersResponse, type PendingFolderOffer, type PullOrder, type Versioning, type VersioningType, diskFreeUnits, pullOrderTexts } from "./api/types.js";
import { versioningParamKeys, versioningTypeTexts } from "./api/versioningText.js";
import { conflictIndexes } from "./conflicts.js";
import { RequestError } from "./http.js";
import type { SetupLayout } from "./setupRepo.js";
import { type HandoffCounts, folderLayered } from "./folderLayered.js";
import { handoffEntryCount, withHandoffFlags } from "./handoffFolders.js";
import { type NodeOs, placeFolders } from "./treePaths.js";
import { type SyncthingClient, type SyncthingDeviceConfig, SyncthingError, type PendingFolders, type SyncthingFolderSettings, SyncthingUnavailable, instanceFolders } from "./syncthing.js";

/** A node of this host whose Syncthing answers; `root` and `os` place its folders in the explorer's tree. */
export interface FolderInstance {
  nodeId: string;
  nodeName: string;
  host: string;
  client: SyncthingClient;
  root: string | null;
  os: NodeOs;
}

/** Where the index reads from; tests hand in fake instances and peers. */
export interface FolderIndexSources {
  localInstances: () => Promise<FolderInstance[]>;
  /** Each other host's `/api/folders?scope=local`; a host that cannot be reached is left out. */
  peerFolders: () => Promise<FolderSummary[]>;
  /** Each other host's `/api/folders/<id>?scope=local`, from the hosts that have the folder. */
  peerFolderDetails: (folderId: string) => Promise<FolderDetailResponse[]>;
  layout: () => Promise<SetupLayout | null>;
  /** What each node's contract on this host names, for the folder's per-node hand-offs; none counts nothing. */
  handoffCounts?: HandoffCounts;
}

interface InstanceFolders {
  copies: FolderCopy[];
  offers: PendingFolderOffer[];
  offersError: string | null;
  foldersError: string | null;
}

function deviceName(devices: SyncthingDeviceConfig[], deviceId: string): string {
  return deviceDisplayName(devices.find((device) => device.deviceID === deviceId)?.name, deviceId);
}

export function offersOf(instance: Pick<FolderInstance, "nodeId" | "nodeName">, devices: SyncthingDeviceConfig[], pending: PendingFolders): PendingFolderOffer[] {
  return Object.entries(pending).flatMap(([folderId, entry]) =>
    Object.entries(entry.offeredBy).map(([offeredBy, offer]) => ({
      nodeId: instance.nodeId,
      nodeName: instance.nodeName,
      folderId,
      label: offer.label,
      offeredBy,
      offeredByName: deviceName(devices, offeredBy),
      time: offer.time,
      receiveEncrypted: offer.receiveEncrypted,
    })),
  );
}

/** A refused read costs only the offers; a Syncthing that stops answering mid-read is left to the caller. */
async function readPending(client: SyncthingClient): Promise<{ pending: PendingFolders; error: string | null }> {
  try {
    return { pending: await client.pendingFolders(), error: null };
  } catch (error) {
    if (error instanceof SyncthingError && !(error instanceof SyncthingUnavailable)) return { pending: {}, error: error.message };
    throw error;
  }
}

/**
 * @implNote An instance that does not answer is left out, as the Nodes page shows it without folders;
 * one that refuses is left out and named, so one node's refusal never costs the others' folders.
 */
async function readInstance(instance: FolderInstance): Promise<InstanceFolders> {
  try {
    const { folders, devices } = await instanceFolders(instance.client);
    const copies = folders.map(({ config, view }) => ({ ...view, conflicts: conflictIndexes.count(instance.nodeId, view.id), conflictsMore: conflictIndexes.hasMore(instance.nodeId, view.id), nodeId: instance.nodeId, nodeName: instance.nodeName, host: instance.host, local: true, paused: config.paused }));
    const { pending, error } = await readPending(instance.client);
    return { copies, offers: offersOf(instance, devices, pending), offersError: error, foldersError: null };
  } catch (error) {
    if (error instanceof SyncthingUnavailable) return { copies: [], offers: [], offersError: null, foldersError: null };
    if (error instanceof SyncthingError) return { copies: [], offers: [], offersError: null, foldersError: error.message };
    throw error;
  }
}

/** Each copy of this host with `handoff` from its node's plan, and a hand-off copy with how many entries its hand-off list holds. */
async function markHandoffCopies(instances: FolderInstance[], reads: InstanceFolders[], layout: SetupLayout | null): Promise<InstanceFolders[]> {
  return Promise.all(
    reads.map(async (read, index) => {
      const copies = await Promise.all(withHandoffFlags(read.copies, layout).map(async (copy) => (copy.handoff ? { ...copy, handoffEntries: (await handoffEntryCount(instances[index].client, copy.id)) ?? 0 } : copy)));
      return { ...read, copies };
    }),
  );
}

function emptySummary(id: string, label: string): FolderSummary {
  return { id, label, priority: null, prioritySource: "none", copies: [], offers: [] };
}

function priorityFor(summary: FolderSummary, layout: SetupLayout | null): Pick<FolderSummary, "priority" | "prioritySource"> {
  const entry = layout?.folders.find((folder) => folder.id === summary.id);
  if (entry) return { priority: entry.priority, prioritySource: "setup-repo" };
  return summary.prioritySource === "setup-repo" ? { priority: summary.priority, prioritySource: "setup-repo" } : { priority: null, prioritySource: "none" };
}

function byLabel(left: FolderSummary, right: FolderSummary): number {
  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }) || left.id.localeCompare(right.id);
}

/** Groups copies and offers by folder ID; a remote summary's copies are marked as not this host's. */
function mergeSummaries(local: Pick<InstanceFolders, "copies" | "offers">[], remote: FolderSummary[], layout: SetupLayout | null, counts?: HandoffCounts): FolderSummary[] {
  const summaries = new Map<string, FolderSummary>();
  const summaryFor = (id: string, label: string) => {
    const existing = summaries.get(id) ?? emptySummary(id, label || id);
    summaries.set(id, existing);
    return existing;
  };
  for (const { copies, offers } of local) {
    for (const copy of copies) summaryFor(copy.id, copy.label).copies.push(copy);
    for (const offer of offers) summaryFor(offer.folderId, offer.label).offers.push(offer);
  }
  for (const peer of remote) {
    const summary = summaryFor(peer.id, peer.label);
    summary.copies.push(...peer.copies.map((copy) => ({ ...copy, local: false })));
    summary.offers.push(...peer.offers);
    if (peer.prioritySource === "setup-repo" && summary.prioritySource === "none") Object.assign(summary, { priority: peer.priority, prioritySource: peer.prioritySource });
  }
  const peerLayered = new Map(remote.flatMap((peer) => (peer.layered ? [[peer.id, peer.layered] as const] : [])));
  return [...summaries.values()].map((summary) => ({ ...summary, ...priorityFor(summary, layout), layered: withPeerCounts(folderLayered(layout, summary.id, counts), peerLayered.get(summary.id)) })).sort(byLabel);
}

/** A peer writes the contracts of its own nodes, so where this host counts nothing for a node, the peer's count stands. */
function withPeerCounts(own: FolderLayered | null, peer: FolderLayered | undefined): FolderLayered | null {
  if (!own || !peer) return own;
  return { ...own, nodes: own.nodes.map((node) => {
    const theirs = peer.nodes.find((entry) => entry.nodeId === node.nodeId);
    return node.pending === null && theirs && theirs.pending !== null ? { ...node, pending: theirs.pending, waiting: theirs.waiting } : node;
  }) };
}

function nodeErrors(instances: FolderInstance[], reads: InstanceFolders[], errorOf: (read: InstanceFolders) => string | null): FoldersResponse["unreadable"] {
  return instances.flatMap((instance, index) => {
    const error = errorOf(reads[index]);
    return error ? [{ nodeId: instance.nodeId, nodeName: instance.nodeName, error }] : [];
  });
}

export async function foldersResponse(scope: "all" | "local", sources: FolderIndexSources): Promise<FoldersResponse> {
  const instances = await sources.localInstances();
  const [read, remote, layout] = await Promise.all([Promise.all(instances.map(readInstance)), scope === "all" ? sources.peerFolders() : Promise.resolve([]), sources.layout()]);
  const local = await markHandoffCopies(instances, read, layout);
  return {
    folders: mergeSummaries(local, remote, layout, sources.handoffCounts),
    unreadable: nodeErrors(instances, local, (read) => read.foldersError),
    offersUnreadable: nodeErrors(instances, local, (read) => read.offersError),
  };
}

function oneOf<Value extends string>(value: string | undefined, allowed: readonly Value[], fallback: Value): Value {
  return allowed.includes(value as Value) ? (value as Value) : fallback;
}

const orders = Object.keys(pullOrderTexts) as PullOrder[];
const versioningTypes = Object.keys(versioningTypeTexts) as VersioningType[];

/**
 * @implNote Only the type's own params: Syncthing keeps the keys of every type a folder had, as a PATCH merges `params`.
 * An external command is shown to every dashboard viewer as written, including any token it embeds.
 */
function versioning(config: SyncthingFolderSettings["versioning"]): Versioning {
  const type = oneOf(config?.type, versioningTypes, "");
  const params = config?.params ?? {};
  return {
    type,
    params: Object.fromEntries(versioningParamKeys[type].flatMap((key) => (typeof params[key] === "string" ? [[key, params[key]]] : []))),
    cleanupIntervalS: config?.cleanupIntervalS ?? 0,
    fsPath: config?.fsPath ?? "",
  };
}

/** @implNote Built field by field, so nothing Syncthing adds later (or a password) reaches the page. */
export function folderSettings(config: SyncthingFolderSettings): FolderSettings {
  return {
    id: config.id,
    label: config.label,
    path: config.path,
    type: config.type,
    paused: config.paused,
    rescanIntervalS: config.rescanIntervalS ?? 0,
    fsWatcherEnabled: config.fsWatcherEnabled ?? false,
    fsWatcherDelayS: config.fsWatcherDelayS ?? 0,
    ignorePerms: config.ignorePerms ?? false,
    order: oneOf(config.order, orders, "random"),
    minDiskFree: { value: config.minDiskFree?.value ?? 0, unit: oneOf(config.minDiskFree?.unit, diskFreeUnits, "%") },
    maxConflicts: config.maxConflicts ?? 0,
    syncOwnership: config.syncOwnership ?? false,
    syncXattrs: config.syncXattrs ?? false,
    devices: config.devices.map((device) => ({ deviceId: device.deviceID, encrypted: Boolean(device.encryptionPassword) })),
    versioning: versioning(config.versioning),
  };
}

async function localSettings(folderId: string, instances: FolderInstance[], copies: FolderCopy[]): Promise<Record<string, FolderSettings>> {
  const holders = instances.filter((instance) => copies.some((copy) => copy.local && copy.nodeId === instance.nodeId));
  const entries = await Promise.all(
    holders.map(async (instance) => {
      try {
        return [[instance.nodeId, folderSettings(await instance.client.folderSettings(folderId))] as const];
      } catch {
        return [];
      }
    }),
  );
  return Object.fromEntries(entries.flat());
}

export async function folderDetail(folderId: string, scope: "all" | "local", sources: FolderIndexSources): Promise<FolderDetailResponse> {
  const instances = await sources.localInstances();
  const [read, remote, layout] = await Promise.all([
    Promise.all(instances.map(readInstance)),
    scope === "all" ? sources.peerFolderDetails(folderId) : Promise.resolve([]),
    sources.layout(),
  ]);
  const local = await markHandoffCopies(instances, read, layout);
  const onlyThisFolder = local.map(({ copies, offers }) => ({ copies: copies.filter((copy) => copy.id === folderId), offers: offers.filter((offer) => offer.folderId === folderId) }));
  const [summary] = mergeSummaries(onlyThisFolder, remote.map((detail) => detail.summary).filter((peer) => peer.id === folderId), layout, sources.handoffCounts);
  if (!summary) throw new RequestError(404, `no folder ${folderId}`);
  const settings = await localSettings(folderId, instances, summary.copies);
  for (const detail of remote) Object.assign(settings, detail.settings);
  return { summary, settings, treePath: treePathOf(summary, instances, remote, layout) };
}

/**
 * Where the explorer places the folder's root: as the first node of this host with a copy places it, else as the host
 * of a copy elsewhere placed it, else an offer's place (the layout's path or "Other folders").
 */
function treePathOf(summary: FolderSummary, instances: FolderInstance[], remote: FolderDetailResponse[], layout: SetupLayout | null): string | null {
  for (const copy of summary.copies) {
    const instance = instances.find((candidate) => copy.local && candidate.nodeId === copy.nodeId);
    if (instance) return placeFolders([{ id: summary.id, label: summary.label, path: copy.path }], instance.root, instance.os, layout)[0].relativePath;
  }
  const placedElsewhere = remote.find((detail) => typeof detail.treePath === "string")?.treePath;
  if (placedElsewhere) return placedElsewhere;
  return summary.offers.length ? placeFolders([{ id: summary.id, label: summary.label, path: "" }], null, "linux", layout)[0].relativePath : null;
}
