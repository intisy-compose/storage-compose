import assert from "node:assert/strict";
import type { NodePlan } from "../src/nodePlan.js";
import { managedIgnoreLines } from "../src/reconcileNode.js";
import { type SyncthingClient, SyncthingUnavailable } from "../src/syncthing.js";

export const ownId = "LAPTOP-ID";
export const keeperId = "KEEPER-ID";
export const phoneId = "PHONE-ID";

export type SyncthingObject = Record<string, unknown>;

export interface Sent {
  method: string;
  path: string;
  body: unknown;
}

export function versioningOf(maxAgeDays: number | null): SyncthingObject {
  return maxAgeDays === null
    ? { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" }
    : { type: "staggered", params: { maxAge: String(maxAgeDays * 86400) }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" };
}

/** A node's Syncthing in memory: its folders, devices and ignore files, every write kept. */
export class FakeSyncthing {
  sent: Sent[] = [];
  answers = true;
  folders: SyncthingObject[] = [];
  ignores = new Map<string, string[]>();
  devices: SyncthingObject[] = [{ deviceID: ownId }, { deviceID: keeperId }, { deviceID: phoneId }];
  /** Runs before each request is answered, as another writer could change the node between two requests. */
  onRequest: ((method: string, path: string) => void) | null = null;
  /** Requests whose path matches fail with this error. */
  failing: { path: RegExp; error: Error } | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.answers) throw new SyncthingUnavailable(`${method} ${path}: connection refused`);
    this.onRequest?.(method, path);
    if (method !== "GET" && this.failing?.path.test(path)) throw this.failing.error;
    if (method !== "GET") this.sent.push({ method, path, body });
    if (method === "GET" && path === "/system/status") return { myID: ownId } as T;
    if (method === "GET" && path === "/config/folders") return structuredClone(this.folders) as T;
    if (method === "GET" && path === "/config/devices") return structuredClone(this.devices) as T;
    const folder = /^\/config\/folders\/([^/]+)$/.exec(path);
    if (folder) {
      const entry = this.folders.find((candidate) => candidate.id === decodeURIComponent(folder[1]));
      if (!entry) throw new Error(`no folder ${folder[1]}`);
      if (method === "GET") return structuredClone(entry) as T;
      if (method === "PATCH") {
        Object.assign(entry, structuredClone(body));
        return null as T;
      }
    }
    const ignores = /^\/db\/ignores\?folder=(.+)$/.exec(path);
    if (ignores) {
      const id = decodeURIComponent(ignores[1]);
      if (method === "POST") this.ignores.set(id, [...((body as { ignore: string[] }).ignore)]);
      return { ignore: this.ignores.get(id) ?? [], expanded: [], error: null } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  myId(): Promise<string> {
    return this.request<{ myID: string }>("GET", "/system/status").then((status) => status.myID);
  }

  folderSettings(folderId: string): Promise<SyncthingObject> {
    return this.request("GET", `/config/folders/${encodeURIComponent(folderId)}`);
  }

  devicesList(): Promise<SyncthingObject[]> {
    return this.request("GET", "/config/devices");
  }

  writes(): Sent[] {
    return this.sent;
  }
}

/** The client methods the reconciler uses, answered by the fake. */
export function clientOf(syncthing: FakeSyncthing): SyncthingClient {
  return {
    request: syncthing.request.bind(syncthing),
    myId: syncthing.myId.bind(syncthing),
    folders: () => syncthing.request("GET", "/config/folders"),
    devices: () => syncthing.request("GET", "/config/devices"),
    folderSettings: syncthing.folderSettings.bind(syncthing),
  } as unknown as SyncthingClient;
}

/** A Syncthing whose every planned folder is exactly as the plan has it. */
export function onPlan(plan: NodePlan): FakeSyncthing {
  const syncthing = new FakeSyncthing();
  for (const folder of plan.folders) {
    syncthing.folders.push({
      id: folder.id,
      label: folder.label,
      path: folder.path,
      type: folder.type,
      paused: false,
      devices: folder.devices.map((deviceID) => ({ deviceID, introducedBy: "", encryptionPassword: "" })),
      versioning: versioningOf(folder.versioning?.maxAgeDays ?? null),
    });
    syncthing.ignores.set(folder.id, managedIgnoreLines(folder.ignores));
  }
  return syncthing;
}

export function folderOf(syncthing: FakeSyncthing, id: string): SyncthingObject {
  const found = syncthing.folders.find((entry) => entry.id === id);
  assert.ok(found, `folder ${id}`);
  return found;
}
