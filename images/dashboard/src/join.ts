import { readFile, rename, writeFile } from "node:fs/promises";
import type { JoinDevice, JoinFolder, JoinNodeRequest, JoinRequest, JoinResponse } from "./api/types.js";
import type { SetupLayout, SetupRecordResult } from "./setupRepo.js";
import type { SyncthingDeviceConfig } from "./syncthing.js";
import type { WhoIs } from "./tailnet.js";

export class JoinError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the join needs of one Syncthing instance on this host. */
export interface JoinInstance {
  name: string;
  addresses: string[];
  myId(): Promise<string>;
  addDevice(device: SyncthingDeviceConfig): Promise<void>;
  shareFolder(folderId: string, deviceId: string): Promise<boolean>;
}

export interface JoinedDevice {
  name: string;
  syncthingDeviceId: string;
  os: JoinRequest["os"];
  nodes: JoinNodeRequest[];
  joinedAt: string;
  tailnetName: string;
  setup: SetupRecordResult | null;
}

export interface JoinRecords {
  all(): Promise<Record<string, JoinedDevice>>;
  put(device: JoinedDevice): Promise<void>;
}

export interface JoinDependencies {
  whois(address: string): Promise<WhoIs | null>;
  owner(): Promise<string | null>;
  requiredTag: string;
  instances(): Promise<JoinInstance[]>;
  layout(): Promise<SetupLayout | null>;
  records: JoinRecords;
  /** Null when no setup repo is configured; the admission is then only in the local record. */
  recordInSetup: ((name: string, deviceId: string, root: string | null) => Promise<SetupRecordResult>) | null;
  now(): Date;
}

const deviceIdPattern = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;
const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const operatingSystems = ["linux", "windows", "macos"];

export function isDeviceId(value: string): boolean {
  return deviceIdPattern.test(value);
}

/** A caller not on our tailnet, or neither owned by the owner nor tagged for storage, is refused. */
export async function admitCaller(dependencies: JoinDependencies, address: string | null): Promise<WhoIs> {
  if (!address) throw new JoinError(403, "the caller's tailnet address is unknown; join over the tailnet");
  const caller = await dependencies.whois(address).catch(() => null);
  if (!caller) throw new JoinError(403, `${address} is not a device of this tailnet`);
  if (caller.tags.includes(dependencies.requiredTag)) return caller;
  const owner = await dependencies.owner().catch(() => null);
  if (owner && caller.loginName === owner) return caller;
  throw new JoinError(403, `${caller.nodeName || address} is neither owned by ${owner ?? "the tailnet's owner"} nor tagged ${dependencies.requiredTag}`);
}

export function validateJoinRequest(body: unknown): JoinRequest {
  const request = (body ?? {}) as Partial<JoinRequest>;
  if (typeof request.name !== "string" || !namePattern.test(request.name)) throw new JoinError(400, "name must match [a-z0-9-]");
  if (typeof request.os !== "string" || !operatingSystems.includes(request.os)) throw new JoinError(400, "os must be linux, windows or macos");
  if (typeof request.syncthingDeviceId !== "string" || !isDeviceId(request.syncthingDeviceId)) throw new JoinError(400, "syncthingDeviceId is not a Syncthing device ID");
  if (!Array.isArray(request.nodes) || request.nodes.length === 0) throw new JoinError(400, "nodes must list at least one node");
  for (const node of request.nodes) {
    if (node?.kind !== "drive" && node?.kind !== "folder") throw new JoinError(400, "a node's kind must be drive or folder");
    if (typeof node.path !== "string" || !node.path) throw new JoinError(400, "a node needs a path");
    if (!Number.isInteger(node.threshold) || node.threshold < 0 || node.threshold > 100) throw new JoinError(400, "a node's threshold must be 0 to 100");
  }
  return request as JoinRequest;
}

/** A name already admitted, here or in the setup repo, under another real device ID. */
export function conflictingId(name: string, deviceId: string, layout: SetupLayout | null, records: Record<string, JoinedDevice>): string | null {
  const recorded = records[name]?.syncthingDeviceId;
  if (recorded && recorded !== deviceId) return recorded;
  const listed = layout?.devices.find((device) => device.name === name)?.id;
  if (listed && isDeviceId(listed) && listed !== deviceId) return listed;
  return null;
}

function joinPath(root: string, relativePath: string, os: JoinRequest["os"]): string {
  const separator = os === "windows" || /^[A-Za-z]:/.test(root) ? "\\" : "/";
  const parts = relativePath.split("/");
  return root.replace(/[\\/]+$/, "") + separator + parts.join(separator);
}

/**
 * The folders the device's thresholds admit, each placed on the node with the lowest threshold that
 * keeps it. Priority 0 never leaves its node.
 */
export function admittedFolders(layout: SetupLayout | null, request: JoinRequest): JoinFolder[] {
  if (!layout) return [];
  const nodes = [...request.nodes].sort((left, right) => left.threshold - right.threshold);
  const folders: JoinFolder[] = [];
  for (const folder of layout.folders) {
    if (folder.priority <= 0) continue;
    const node = nodes.find((candidate) => folder.priority >= candidate.threshold);
    if (node) folders.push({ id: folder.id, path: joinPath(node.path, folder.relativePath, request.os), type: "sendreceive" });
  }
  return folders;
}

async function shareWithInstances(instances: JoinInstance[], request: JoinRequest, folders: JoinFolder[]): Promise<JoinDevice[]> {
  const devices: JoinDevice[] = [];
  for (const instance of instances) {
    await instance.addDevice({ deviceID: request.syncthingDeviceId, name: request.name, addresses: ["dynamic"] });
    for (const folder of folders) await instance.shareFolder(folder.id, request.syncthingDeviceId);
    devices.push({ name: instance.name, syncthingDeviceId: await instance.myId(), addresses: instance.addresses });
  }
  return devices;
}

export async function handleJoin(dependencies: JoinDependencies, address: string | null, body: unknown): Promise<{ response: JoinResponse; setup: SetupRecordResult | null }> {
  const caller = await admitCaller(dependencies, address);
  const request = validateJoinRequest(body);
  const [layout, records] = await Promise.all([dependencies.layout(), dependencies.records.all()]);
  const conflict = conflictingId(request.name, request.syncthingDeviceId, layout, records);
  if (conflict) throw new JoinError(409, `${request.name} is already admitted with device ${conflict}; a reinstalled device is re-admitted from the dashboard`);
  const folders = admittedFolders(layout, request);
  const devices = await shareWithInstances(await dependencies.instances(), request, folders);
  const known = records[request.name];
  const listed = layout?.devices.find((device) => device.name === request.name);
  const isRecordedInSetup = listed?.id === request.syncthingDeviceId && listed.joined;
  let setup = known?.setup ?? null;
  if (dependencies.recordInSetup && (!isRecordedInSetup || !setup?.pushed)) {
    setup = await dependencies.recordInSetup(request.name, request.syncthingDeviceId, request.nodes[0]?.path ?? null);
  }
  if (!dependencies.recordInSetup) setup = { committed: false, pushed: false, message: "no setup repo is configured (SETUP_REPO_DIR); the admission is recorded on this host only" };
  await dependencies.records.put({
    name: request.name,
    syncthingDeviceId: request.syncthingDeviceId,
    os: request.os,
    nodes: request.nodes,
    joinedAt: known?.joinedAt ?? dependencies.now().toISOString(),
    tailnetName: caller.nodeName,
    setup,
  });
  return { response: { devices, folders }, setup };
}

/** The local record of admitted devices, kept in the status volume beside the setup repo's list. */
export function fileJoinRecords(path: string): JoinRecords {
  const all = async (): Promise<Record<string, JoinedDevice>> => {
    try {
      return (JSON.parse(await readFile(path, "utf8")) as { devices: Record<string, JoinedDevice> }).devices ?? {};
    } catch {
      return {};
    }
  };
  return {
    all,
    async put(device) {
      const devices = { ...(await all()), [device.name]: device };
      await writeFile(`${path}.new`, `${JSON.stringify({ devices }, null, 2)}\n`);
      await rename(`${path}.new`, path);
    },
  };
}
