import { deviceDisplayName } from "./api/deviceText.js";
import { type FolderCopy, type FolderDetailResponse, type FolderSettings, type FolderSummary, type FoldersResponse, type PendingFolderOffer, type PullOrder, diskFreeUnits, pullOrderTexts } from "./api/types.js";
import { RequestError } from "./http.js";
import type { SetupLayout } from "./setupRepo.js";
import { type SyncthingClient, type SyncthingDeviceConfig, SyncthingError, type PendingFolders, type SyncthingFolderSettings, SyncthingUnavailable, instanceFolders } from "./syncthing.js";

/** A node of this host whose Syncthing answers. */
export interface FolderInstance {
  nodeId: string;
  nodeName: string;
  host: string;
  client: SyncthingClient;
}

/** Where the index reads from; tests hand in fake instances and peers. */
export interface FolderIndexSources {
  localInstances: () => Promise<FolderInstance[]>;
  /** Each other host's `/api/folders?scope=local`; a host that cannot be reached is left out. */
  peerFolders: () => Promise<FolderSummary[]>;
  /** Each other host's `/api/folders/<id>?scope=local`, from the hosts that have the folder. */
  peerFolderDetails: (folderId: string) => Promise<FolderDetailResponse[]>;
  layout: () => Promise<SetupLayout | null>;
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
    const copies = folders.map(({ config, view }) => ({ ...view, nodeId: instance.nodeId, nodeName: instance.nodeName, host: instance.host, local: true, paused: config.paused }));
    const { pending, error } = await readPending(instance.client);
    return { copies, offers: offersOf(instance, devices, pending), offersError: error, foldersError: null };
  } catch (error) {
    if (error instanceof SyncthingUnavailable) return { copies: [], offers: [], offersError: null, foldersError: null };
    if (error instanceof SyncthingError) return { copies: [], offers: [], offersError: null, foldersError: error.message };
    throw error;
  }
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
function mergeSummaries(local: Pick<InstanceFolders, "copies" | "offers">[], remote: FolderSummary[], layout: SetupLayout | null): FolderSummary[] {
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
  return [...summaries.values()].map((summary) => ({ ...summary, ...priorityFor(summary, layout) })).sort(byLabel);
}

function nodeErrors(instances: FolderInstance[], reads: InstanceFolders[], errorOf: (read: InstanceFolders) => string | null): FoldersResponse["unreadable"] {
  return instances.flatMap((instance, index) => {
    const error = errorOf(reads[index]);
    return error ? [{ nodeId: instance.nodeId, nodeName: instance.nodeName, error }] : [];
  });
}

export async function foldersResponse(scope: "all" | "local", sources: FolderIndexSources): Promise<FoldersResponse> {
  const instances = await sources.localInstances();
  const [local, remote, layout] = await Promise.all([Promise.all(instances.map(readInstance)), scope === "all" ? sources.peerFolders() : Promise.resolve([]), sources.layout()]);
  return {
    folders: mergeSummaries(local, remote, layout),
    unreadable: nodeErrors(instances, local, (read) => read.foldersError),
    offersUnreadable: nodeErrors(instances, local, (read) => read.offersError),
  };
}

function oneOf<Value extends string>(value: string | undefined, allowed: readonly Value[], fallback: Value): Value {
  return allowed.includes(value as Value) ? (value as Value) : fallback;
}

const orders = Object.keys(pullOrderTexts) as PullOrder[];
const versioningTypes = ["", "trashcan", "simple", "staggered", "external"] as const;

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
    versioning: {
      type: oneOf(config.versioning?.type, versioningTypes, ""),
      params: { ...(config.versioning?.params ?? {}) },
      cleanupIntervalS: config.versioning?.cleanupIntervalS ?? 0,
      fsPath: config.versioning?.fsPath ?? "",
    },
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
  const [local, remote, layout] = await Promise.all([
    Promise.all(instances.map(readInstance)),
    scope === "all" ? sources.peerFolderDetails(folderId) : Promise.resolve([]),
    sources.layout(),
  ]);
  const onlyThisFolder = local.map(({ copies, offers }) => ({ copies: copies.filter((copy) => copy.id === folderId), offers: offers.filter((offer) => offer.folderId === folderId) }));
  const [summary] = mergeSummaries(onlyThisFolder, remote.map((detail) => detail.summary).filter((peer) => peer.id === folderId), layout);
  if (!summary) throw new RequestError(404, `no folder ${folderId}`);
  const settings = await localSettings(folderId, instances, summary.copies);
  for (const detail of remote) Object.assign(settings, detail.settings);
  return { summary, settings };
}
