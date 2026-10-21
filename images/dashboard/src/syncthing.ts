import { readFile } from "node:fs/promises";
import type { FolderFile, FolderPeer, FolderType, NodeFolder, NodeSync, Peer, RemoteState, SyncthingDevice, SyncthingInstance } from "./api/types.js";

export interface SyncthingEndpoint {
  url: string;
  apiKey: string;
}

export interface SyncthingFolderConfig {
  id: string;
  label: string;
  path: string;
  type: FolderType;
  paused: boolean;
  devices: { deviceID: string; introducedBy?: string; encryptionPassword?: string }[];
}

/** The fields of a folder's full configuration the dashboard reads; Syncthing sends many more. */
export interface SyncthingFolderSettings extends SyncthingFolderConfig {
  rescanIntervalS?: number;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  ignorePerms?: boolean;
  order?: string;
  minDiskFree?: { value: number; unit: string };
  maxConflicts?: number;
  syncOwnership?: boolean;
  syncXattrs?: boolean;
  versioning?: { type?: string; params?: Record<string, string>; cleanupIntervalS?: number; fsPath?: string };
}

/** `/rest/cluster/pending/folders`: folder ID, then the offering device's ID. */
export type PendingFolders = Record<string, { offeredBy: Record<string, { time: string; label: string; receiveEncrypted: boolean }> }>;

export interface SyncthingDeviceConfig {
  deviceID: string;
  name: string;
  addresses: string[];
  paused?: boolean;
}

interface ConnectionTotals {
  inBytesTotal: number;
  outBytesTotal: number;
}

interface Connection extends ConnectionTotals {
  connected: boolean;
  type: string;
  address: string;
  clientVersion: string;
}

interface Connections {
  total: ConnectionTotals;
  connections: Record<string, Connection>;
}

interface FolderStatus {
  state: string;
  globalBytes: number;
  globalFiles?: number;
  globalDirectories?: number;
  needBytes: number;
  needFiles?: number;
  pullErrors?: number;
  receiveOnlyTotalItems?: number;
}

interface FolderStats {
  lastScan?: string;
  lastFile?: FolderFile;
}

interface Completion {
  completion: number;
  needBytes: number;
  remoteState?: string;
}

interface SystemStatus {
  myID: string;
  uptime?: number;
  cpuPercent?: number;
  sys?: number;
  connectionServiceStatus?: Record<string, { error?: string | null; lanAddresses?: string[]; wanAddresses?: string[] }>;
  discoveryStatus?: Record<string, { error?: string | null }>;
}

/** What one Syncthing instance says about itself, its folders and the devices it knows. */
export interface InstanceView {
  device: SyncthingDevice;
  instance: SyncthingInstance;
  folders: NodeFolder[];
  sync: NodeSync;
  peers: Peer[];
}

export class SyncthingError extends Error {}

/** The instance did not answer at all: refused, unreachable or past the timeout. */
export class SyncthingUnavailable extends SyncthingError {}

export class SyncthingClient {
  constructor(
    readonly endpoint: SyncthingEndpoint,
    private readonly timeoutMs = 4000,
  ) {}

  /** Any path of the instance's GUI, `/qr/` or `/rest/debug/support` included, answered as it comes. */
  async raw(method: string, path: string, timeoutMs = this.timeoutMs, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.endpoint.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "X-API-Key": this.endpoint.apiKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SyncthingUnavailable(`${method} ${path}: ${(error as Error).message}`);
    }
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const response = await this.raw(method, `/rest${path}`, timeoutMs, body);
    const text = await response.text().catch((error: Error) => {
      throw new SyncthingUnavailable(`${method} ${path}: ${error.message}`);
    });
    if (!response.ok) throw new SyncthingError(`${method} ${path}: HTTP ${response.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  myId(): Promise<string> {
    return this.request<{ myID: string }>("GET", "/system/status").then((status) => status.myID);
  }

  folders(): Promise<SyncthingFolderConfig[]> {
    return this.request("GET", "/config/folders");
  }

  devices(): Promise<SyncthingDeviceConfig[]> {
    return this.request("GET", "/config/devices");
  }

  folderSettings(folderId: string): Promise<SyncthingFolderSettings> {
    return this.request("GET", `/config/folders/${encodeURIComponent(folderId)}`);
  }

  pendingFolders(): Promise<PendingFolders> {
    return this.request<PendingFolders | null>("GET", "/cluster/pending/folders").then((pending) => pending ?? {});
  }

  /** Adds the device, or leaves one with the same ID as it is. */
  async addDevice(device: SyncthingDeviceConfig): Promise<void> {
    const known = await this.devices();
    if (known.some((entry) => entry.deviceID === device.deviceID)) return;
    await this.request("POST", "/config/devices", device);
  }

  async shareFolder(folderId: string, deviceId: string): Promise<boolean> {
    const folder = (await this.folders()).find((entry) => entry.id === folderId);
    if (!folder) return false;
    if (folder.devices.some((entry) => entry.deviceID === deviceId)) return true;
    await this.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, {
      devices: [...folder.devices, { deviceID: deviceId }],
    });
    return true;
  }
}

export async function apiKeyFromConfig(configXmlPath: string): Promise<string | null> {
  try {
    return (await readFile(configXmlPath, "utf8")).match(/<apikey>([^<]+)<\/apikey>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const previousTotals = new Map<string, { at: number; totals: Map<string, ConnectionTotals> }>();

/** @implNote Syncthing reports byte totals only, so a rate is the change since this host's previous poll. */
function rates(instanceKey: string, connections: Connections): Map<string, { inRate: number; outRate: number }> {
  const now = Date.now();
  const current = new Map<string, ConnectionTotals>([["total", connections.total], ...Object.entries(connections.connections)]);
  const previous = previousTotals.get(instanceKey);
  previousTotals.set(instanceKey, { at: now, totals: current });
  const result = new Map<string, { inRate: number; outRate: number }>();
  for (const [key, totals] of current) {
    const before = previous?.totals.get(key);
    const seconds = previous ? (now - previous.at) / 1000 : 0;
    if (!before || seconds <= 0) {
      result.set(key, { inRate: 0, outRate: 0 });
      continue;
    }
    result.set(key, {
      inRate: Math.max(0, (totals.inBytesTotal - before.inBytesTotal) / seconds),
      outRate: Math.max(0, (totals.outBytesTotal - before.outBytesTotal) / seconds),
    });
  }
  return result;
}

export function folderCompletion(status: FolderStatus): number {
  if (!status.globalBytes) return 100;
  return Math.max(0, Math.min(100, (100 * (status.globalBytes - status.needBytes)) / status.globalBytes));
}

function isWaitedFor(peer: Peer): boolean {
  if (!peer.connected || peer.remoteState === "paused" || peer.remoteState === "notSharing") return false;
  return peer.remoteState === "unknown" || peer.completion < 100;
}

/**
 * @implNote A node is "waiting" when its own folders are done and a connected peer that shares
 * folders with it has not accepted them or does not hold everything yet. A disconnected peer is not
 * waited for: its last known completion says nothing about now. A folder that is only scanning
 * does not hide the wait.
 */
export function overallSync(folders: NodeFolder[], peers: Peer[] = []): NodeSync {
  const now = new Date().toISOString();
  const active = folders.filter((folder) => folder.state !== "paused");
  const completion = active.length ? active.reduce((sum, folder) => sum + folder.completion, 0) / active.length : 100;
  if (active.some((folder) => folder.state === "error")) return { state: "error", completion, lastSeen: now };
  const isTransferring = active.some((folder) => /sync/.test(folder.state) || folder.completion < 100);
  if (isTransferring) return { state: "syncing", completion, lastSeen: now };
  const waited = peers.filter(isWaitedFor);
  const isChecking = active.some((folder) => /scan|clean/.test(folder.state));
  if (!waited.length) return { state: isChecking ? "syncing" : "idle", completion, lastSeen: now };
  const lowest = Math.min(completion, ...waited.map((peer) => peer.completion));
  return { state: "waiting", completion: lowest, lastSeen: now, waitingFor: waited.map((peer) => peer.deviceId) };
}

function emptyFolder(folder: SyncthingFolderConfig, sharedWith: FolderPeer[], state: string): NodeFolder {
  return {
    id: folder.id,
    label: folder.label,
    path: folder.path,
    type: folder.type,
    state,
    completion: 0,
    errors: 0,
    needItems: 0,
    needBytes: 0,
    globalBytes: 0,
    globalFiles: 0,
    globalDirectories: 0,
    lastScan: null,
    lastFile: null,
    localChanged: 0,
    sharedWith,
  };
}

function usableTime(value: string | undefined): string | null {
  return value && !value.startsWith("0001") && !value.startsWith("1970") ? value : null;
}

async function folderView(client: SyncthingClient, folder: SyncthingFolderConfig, sharedWith: FolderPeer[], stats: FolderStats | undefined): Promise<NodeFolder> {
  if (folder.paused) return emptyFolder(folder, sharedWith, "paused");
  try {
    const status = await client.request<FolderStatus>("GET", `/db/status?folder=${encodeURIComponent(folder.id)}`);
    return {
      ...emptyFolder(folder, sharedWith, status.state || "unknown"),
      completion: folderCompletion(status),
      errors: status.pullErrors ?? 0,
      needItems: status.needFiles ?? 0,
      needBytes: status.needBytes ?? 0,
      globalBytes: status.globalBytes ?? 0,
      globalFiles: status.globalFiles ?? 0,
      globalDirectories: status.globalDirectories ?? 0,
      lastScan: usableTime(stats?.lastScan),
      lastFile: stats?.lastFile && usableTime(stats.lastFile.at) ? stats.lastFile : null,
      localChanged: status.receiveOnlyTotalItems ?? 0,
    };
  } catch {
    return emptyFolder(folder, sharedWith, "unknown");
  }
}

function addressesOf(status: SystemStatus): string[] {
  const addresses = Object.values(status.connectionServiceStatus ?? {}).flatMap((service) => [...(service.lanAddresses ?? []), ...(service.wanAddresses ?? [])]);
  return [...new Set(addresses)];
}

function instanceOf(status: SystemStatus, connections: Connections): SyncthingInstance {
  return {
    uptime: status.uptime ?? 0,
    cpuPercent: status.cpuPercent ?? 0,
    memoryBytes: status.sys ?? 0,
    listeners: Object.entries(status.connectionServiceStatus ?? {}).map(([address, service]) => ({ address, error: service.error ?? null })),
    discoveryErrors: Object.entries(status.discoveryStatus ?? {}).flatMap(([method, entry]) => (entry.error ? [`${method}: ${entry.error}`] : [])),
    inTotal: connections.total.inBytesTotal,
    outTotal: connections.total.outBytesTotal,
  };
}

async function peerCompletion(client: SyncthingClient, deviceId: string): Promise<Completion> {
  try {
    return await client.request<Completion>("GET", `/db/completion?device=${encodeURIComponent(deviceId)}`);
  } catch {
    return { completion: 0, needBytes: 0, remoteState: "unknown" };
  }
}

function remoteStateOf(device: SyncthingDeviceConfig, sharedFolders: string[], completion: Completion): RemoteState {
  if (device.paused) return "paused";
  if (!sharedFolders.length) return "notSharing";
  return completion.remoteState === "unknown" ? "unknown" : "valid";
}

interface PeerInputs {
  device: SyncthingDeviceConfig;
  connection: Connection | undefined;
  rate: { inRate: number; outRate: number };
  lastSeen: string | undefined;
  sharedFolders: string[];
  completion: Completion;
}

function peerOf({ device, connection, rate, lastSeen, sharedFolders, completion }: PeerInputs): Peer {
  return {
    deviceId: device.deviceID,
    name: device.name,
    connected: connection?.connected ?? false,
    paused: device.paused ?? false,
    connectionType: connection?.connected ? connection.type : null,
    address: connection?.connected ? connection.address : null,
    version: connection?.clientVersion || null,
    inRate: rate.inRate,
    outRate: rate.outRate,
    lastSeen: usableTime(lastSeen),
    completion: completion.completion,
    needBytes: completion.needBytes,
    remoteState: remoteStateOf(device, sharedFolders, completion),
    folders: sharedFolders,
  };
}

function sharedWithOf(folder: SyncthingFolderConfig, ownId: string, names: Map<string, string>): FolderPeer[] {
  return folder.devices.filter((entry) => entry.deviceID !== ownId).map((entry) => ({ deviceId: entry.deviceID, name: names.get(entry.deviceID) ?? entry.deviceID.slice(0, 7) }));
}

async function optionalFolderStats(client: SyncthingClient): Promise<Record<string, FolderStats>> {
  try {
    return await client.request<Record<string, FolderStats>>("GET", "/stats/folder");
  } catch {
    return {};
  }
}

function folderViews(client: SyncthingClient, ownId: string, folderConfigs: SyncthingFolderConfig[], deviceConfigs: SyncthingDeviceConfig[], folderStats: Record<string, FolderStats>): Promise<NodeFolder[]> {
  const names = new Map(deviceConfigs.map((device) => [device.deviceID, device.name]));
  return Promise.all(folderConfigs.map((folder) => folderView(client, folder, sharedWithOf(folder, ownId, names), folderStats[folder.id])));
}

/** One instance's folders as the Nodes page shows them, with each folder's configuration and the devices it knows. */
export async function instanceFolders(client: SyncthingClient): Promise<{ folders: { config: SyncthingFolderConfig; view: NodeFolder }[]; devices: SyncthingDeviceConfig[] }> {
  const [ownId, folderConfigs, deviceConfigs, folderStats] = await Promise.all([client.myId(), client.folders(), client.devices(), optionalFolderStats(client)]);
  const views = await folderViews(client, ownId, folderConfigs, deviceConfigs, folderStats);
  return { folders: folderConfigs.map((config, index) => ({ config, view: views[index] })), devices: deviceConfigs };
}

/** Everything the Nodes page needs from one instance, or null while it does not answer. */
export async function instanceView(key: string, endpoint: SyncthingEndpoint): Promise<InstanceView | null> {
  const client = new SyncthingClient(endpoint);
  try {
    const [status, version, connections, folderConfigs, deviceConfigs, deviceStats, folderStats] = await Promise.all([
      client.request<SystemStatus>("GET", "/system/status"),
      client.request<{ version: string }>("GET", "/system/version"),
      client.request<Connections>("GET", "/system/connections"),
      client.folders(),
      client.devices(),
      client.request<Record<string, { lastSeen: string }>>("GET", "/stats/device"),
      optionalFolderStats(client),
    ]);
    const folderRates = rates(key, connections);
    const folders = await folderViews(client, status.myID, folderConfigs, deviceConfigs, folderStats);
    const total = folderRates.get("total") ?? { inRate: 0, outRate: 0 };
    const peers = await Promise.all(
      deviceConfigs
        .filter((device) => device.deviceID !== status.myID)
        .map(async (device) =>
          peerOf({
            device,
            connection: connections.connections[device.deviceID],
            rate: folderRates.get(device.deviceID) ?? { inRate: 0, outRate: 0 },
            lastSeen: deviceStats[device.deviceID]?.lastSeen,
            sharedFolders: folderConfigs.filter((folder) => folder.devices.some((entry) => entry.deviceID === device.deviceID)).map((folder) => folder.id),
            completion: await peerCompletion(client, device.deviceID),
          }),
        ),
    );
    return {
      device: { deviceId: status.myID, addresses: addressesOf(status), connectionType: null, inRate: total.inRate, outRate: total.outRate, version: version.version },
      instance: instanceOf(status, connections),
      folders,
      sync: overallSync(folders, peers),
      peers,
    };
  } catch {
    return null;
  }
}
