import { readFile } from "node:fs/promises";
import type { NodeFolder, NodeSync, SyncthingDevice } from "./api/types.js";

export interface SyncthingEndpoint {
  url: string;
  apiKey: string;
}

export interface SyncthingFolderConfig {
  id: string;
  label: string;
  path: string;
  type: string;
  paused: boolean;
  devices: { deviceID: string; introducedBy?: string; encryptionPassword?: string }[];
}

export interface SyncthingDeviceConfig {
  deviceID: string;
  name: string;
  addresses: string[];
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
  needBytes: number;
}

/** What one Syncthing instance says about itself, its folders and the devices it knows. */
export interface InstanceView {
  device: SyncthingDevice;
  folders: NodeFolder[];
  sync: NodeSync;
  peers: PeerView[];
}

export interface PeerView {
  deviceId: string;
  name: string;
  connected: boolean;
  connectionType: string | null;
  address: string | null;
  version: string | null;
  inRate: number;
  outRate: number;
  lastSeen: string | null;
  completion: number;
}

export class SyncthingError extends Error {}

export class SyncthingClient {
  constructor(
    readonly endpoint: SyncthingEndpoint,
    private readonly timeoutMs = 4000,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.endpoint.url.replace(/\/$/, "")}/rest${path}`, {
      method,
      headers: { "X-API-Key": this.endpoint.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new SyncthingError(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    const text = await response.text();
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

export function overallSync(folders: NodeFolder[]): NodeSync {
  const now = new Date().toISOString();
  const active = folders.filter((folder) => folder.state !== "paused");
  const completion = active.length ? active.reduce((sum, folder) => sum + folder.completion, 0) / active.length : 100;
  if (active.some((folder) => folder.state === "error")) return { state: "error", completion, lastSeen: now };
  const isSyncing = active.some((folder) => /sync|scan|clean/.test(folder.state) || folder.completion < 100);
  return { state: isSyncing ? "syncing" : "idle", completion, lastSeen: now };
}

async function folderView(client: SyncthingClient, folder: SyncthingFolderConfig): Promise<NodeFolder> {
  if (folder.paused) return { id: folder.id, path: folder.path, type: folder.type, state: "paused", completion: 0 };
  try {
    const status = await client.request<FolderStatus>("GET", `/db/status?folder=${encodeURIComponent(folder.id)}`);
    return { id: folder.id, path: folder.path, type: folder.type, state: status.state || "unknown", completion: folderCompletion(status) };
  } catch {
    return { id: folder.id, path: folder.path, type: folder.type, state: "unknown", completion: 0 };
  }
}

function addressesOf(status: { connectionServiceStatus?: Record<string, { lanAddresses?: string[]; wanAddresses?: string[] }> }): string[] {
  const addresses = Object.values(status.connectionServiceStatus ?? {}).flatMap((service) => [...(service.lanAddresses ?? []), ...(service.wanAddresses ?? [])]);
  return [...new Set(addresses)];
}

async function peerCompletion(client: SyncthingClient, deviceId: string): Promise<number> {
  try {
    const result = await client.request<{ completion: number }>("GET", `/db/completion?device=${encodeURIComponent(deviceId)}`);
    return result.completion;
  } catch {
    return 0;
  }
}

/** Everything the Nodes page needs from one instance, or null while it does not answer. */
export async function instanceView(key: string, endpoint: SyncthingEndpoint): Promise<InstanceView | null> {
  const client = new SyncthingClient(endpoint);
  try {
    const [status, version, connections, folderConfigs, deviceConfigs, deviceStats] = await Promise.all([
      client.request<{ myID: string; connectionServiceStatus?: Record<string, { lanAddresses?: string[]; wanAddresses?: string[] }> }>("GET", "/system/status"),
      client.request<{ version: string }>("GET", "/system/version"),
      client.request<Connections>("GET", "/system/connections"),
      client.folders(),
      client.devices(),
      client.request<Record<string, { lastSeen: string }>>("GET", "/stats/device"),
    ]);
    const folderRates = rates(key, connections);
    const folders = await Promise.all(folderConfigs.map((folder) => folderView(client, folder)));
    const total = folderRates.get("total") ?? { inRate: 0, outRate: 0 };
    const peers = await Promise.all(
      deviceConfigs
        .filter((device) => device.deviceID !== status.myID)
        .map(async (device): Promise<PeerView> => {
          const connection = connections.connections[device.deviceID];
          const rate = folderRates.get(device.deviceID) ?? { inRate: 0, outRate: 0 };
          const lastSeen = deviceStats[device.deviceID]?.lastSeen ?? null;
          return {
            deviceId: device.deviceID,
            name: device.name,
            connected: connection?.connected ?? false,
            connectionType: connection?.connected ? connection.type : null,
            address: connection?.connected ? connection.address : null,
            version: connection?.clientVersion || null,
            inRate: rate.inRate,
            outRate: rate.outRate,
            lastSeen: lastSeen && !lastSeen.startsWith("1970") ? lastSeen : null,
            completion: await peerCompletion(client, device.deviceID),
          };
        }),
    );
    return {
      device: { deviceId: status.myID, addresses: addressesOf(status), connectionType: null, inRate: total.inRate, outRate: total.outRate, version: version.version },
      folders,
      sync: overallSync(folders),
      peers,
    };
  } catch {
    return null;
  }
}
