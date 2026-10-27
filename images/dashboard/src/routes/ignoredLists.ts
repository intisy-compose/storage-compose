import { deviceDisplayName, shortDeviceId } from "../api/deviceText.js";
import type { IgnoredDeviceEntry, IgnoredFolderEntry, IgnoredLists } from "../api/types.js";
import { RequestError, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, requireLocal } from "../instanceResolver.js";
import type { AnyRoute, WriteNote } from "../routes.js";
import { type SyncthingConfig, changeWholeConfig } from "../wholeConfig.js";
import { decodedSegment } from "./devices.js";

type SyncthingObject = Record<string, unknown>;

function objects(value: unknown): SyncthingObject[] {
  return Array.isArray(value) ? value.filter((entry): entry is SyncthingObject => typeof entry === "object" && entry !== null) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** @implNote Built field by field from the whole configuration, so nothing else of it, its secrets least of all, reaches the page. */
export function ignoredListsOf(config: SyncthingConfig): IgnoredLists {
  const devices: IgnoredDeviceEntry[] = objects(config.remoteIgnoredDevices).map((entry) => ({ deviceId: text(entry.deviceID), name: text(entry.name), address: text(entry.address), time: text(entry.time) }));
  const folders: IgnoredFolderEntry[] = objects(config.devices).flatMap((device) =>
    objects(device.ignoredFolders).map((folder) => ({
      folderId: text(folder.id),
      label: text(folder.label),
      offeredBy: text(device.deviceID),
      offeredByName: deviceDisplayName(text(device.name), text(device.deviceID)),
      time: text(folder.time),
    })),
  );
  return { devices, folders };
}

async function wholeConfig(instance: LocalInstance): Promise<SyncthingConfig> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingConfig | null>("GET", "/config"))) ?? {};
}

export async function readIgnoredLists(instance: LocalInstance): Promise<IgnoredLists> {
  return ignoredListsOf(await wholeConfig(instance));
}

function withoutIgnoredDevice(config: SyncthingConfig, deviceId: string): SyncthingConfig | null {
  const ignored = objects(config.remoteIgnoredDevices);
  const kept = ignored.filter((entry) => entry.deviceID !== deviceId);
  return kept.length === ignored.length ? null : { ...config, remoteIgnoredDevices: kept };
}

function withoutIgnoredFolder(config: SyncthingConfig, folderId: string, offeredBy: string): SyncthingConfig | null {
  const device = objects(config.devices).find((entry) => entry.deviceID === offeredBy);
  const ignored = objects(device?.ignoredFolders);
  if (!device || !ignored.some((folder) => folder.id === folderId)) return null;
  const changed = { ...device, ignoredFolders: ignored.filter((folder) => folder.id !== folderId) };
  return { ...config, devices: objects(config.devices).map((entry) => (entry === device ? changed : entry)) };
}

export interface Unignore {
  lists: IgnoredLists;
  note: WriteNote;
}

function noteOf(instance: LocalInstance, text: string): WriteNote {
  return { nodeId: instance.nodeId, nodeName: instance.name, folderId: null, text: `${instance.name}: ${text}` };
}

/**
 * Takes one device off the node's ignored devices and keeps every other; Syncthing has no endpoint for them, so its whole configuration is written.
 * @implNote A device that is not ignored is 404 before anything is written; one un-ignored elsewhere meanwhile writes nothing and still answers.
 */
export async function unignoreDevice(instance: ResolvedInstance, deviceId: string, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<Unignore> {
  const local = requireLocal(instance);
  const entry = (await readIgnoredLists(local)).devices.find((device) => device.deviceId === deviceId);
  if (!entry) throw new RequestError(404, `${shortDeviceId(deviceId)} is not ignored on ${local.name}`);
  const name = deviceDisplayName(entry.name, deviceId);
  const conflict = `${local.name}'s configuration changed twice while ${name} was being un-ignored; nothing was written, try again`;
  await changeWholeConfig(local, (config) => withoutIgnoredDevice(config, deviceId), conflict, readBackDelaysMs);
  return { lists: await readIgnoredLists(local), note: noteOf(local, `un-ignored device ${name} (${shortDeviceId(deviceId)}), it may ask to connect again`) };
}

function folderName(entry: IgnoredFolderEntry): string {
  return entry.label && entry.label !== entry.folderId ? `${entry.label} (${entry.folderId})` : entry.folderId;
}

/** Takes one folder off the offering device's ignored folders and keeps every other, written as `unignoreDevice` writes. */
export async function unignoreFolder(instance: ResolvedInstance, folderId: string, offeredBy: string | null, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<Unignore> {
  const local = requireLocal(instance);
  if (!offeredBy) throw new RequestError(400, "name the device whose offer of the folder is ignored: ?offeredBy=<device ID>");
  const entry = (await readIgnoredLists(local)).folders.find((folder) => folder.folderId === folderId && folder.offeredBy === offeredBy);
  if (!entry) throw new RequestError(404, `${folderId} from ${shortDeviceId(offeredBy)} is not ignored on ${local.name}`);
  const conflict = `${local.name}'s configuration changed twice while ${folderName(entry)} was being un-ignored; nothing was written, try again`;
  await changeWholeConfig(local, (config) => withoutIgnoredFolder(config, folderId, offeredBy), conflict, readBackDelaysMs);
  return { lists: await readIgnoredLists(local), note: noteOf(local, `un-ignored folder ${folderName(entry)} offered by ${entry.offeredByName}, it may be offered again`) };
}

/** The routes of what a node ignores; `node` resolves the node ID segment of the path. */
export function ignoredListRoutes(node: (segment: string) => Promise<ResolvedInstance>, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/ignored$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await readIgnoredLists(requireLocal(await node(nodeId)))),
    },
    {
      method: "DELETE",
      pattern: /^\/api\/nodes\/([^/]+)\/ignored\/devices\/([^/]+)$/,
      write: async ({ response, params: [nodeId, deviceId] }) => {
        const done = await unignoreDevice(await node(nodeId), decodedSegment(deviceId, "device ID"), readBackDelaysMs);
        sendJson(response, 200, done.lists);
        return done.note;
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/nodes\/([^/]+)\/ignored\/folders\/([^/]+)$/,
      write: async ({ response, url, params: [nodeId, folderId] }) => {
        const done = await unignoreFolder(await node(nodeId), decodedSegment(folderId, "folder ID"), url.searchParams.get("offeredBy"), readBackDelaysMs);
        sendJson(response, 200, done.lists);
        return done.note;
      },
    },
  ];
}
