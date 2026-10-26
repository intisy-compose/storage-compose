import { deviceDisplayName, deviceSettingLabels, shortDeviceId } from "../api/deviceText.js";
import type { DeviceSettings, DeviceSettingsChange } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, forwardRead, requireLocal, resolveInstance } from "../instanceResolver.js";
import type { AnyRoute, WriteNote } from "../routes.js";
import { deviceChangeProblem, deviceSettings, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

async function configuredDevice(instance: LocalInstance, deviceId: string): Promise<SyncthingObject> {
  const devices = await callSyncthing(instance, (client) => client.request<SyncthingObject[] | null>("GET", "/config/devices"));
  const device = (devices ?? []).find((entry) => entry.deviceID === deviceId);
  if (!device) throw new RequestError(404, `${instance.name} has no device ${shortDeviceId(deviceId)}`);
  return device;
}

function devicePath(nodeId: string, deviceId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/devices/${encodeURIComponent(deviceId)}`;
}

/** One device as the node's Syncthing has it configured; another host's node is read through that host's dashboard. */
export async function readDeviceSettings(instance: ResolvedInstance, deviceId: string): Promise<DeviceSettings> {
  if (instance.kind === "remote") {
    const answer = redactConfig(await forwardRead(instance, devicePath(instance.nodeId, deviceId))) as SyncthingObject | null;
    return deviceSettings({ ...(answer ?? {}), deviceID: deviceId });
  }
  return deviceSettings(await configuredDevice(instance, deviceId));
}

type WordedField = Exclude<keyof DeviceSettingsChange, "name" | "paused">;

const wordedFields = (Object.keys(deviceSettingLabels) as (keyof DeviceSettingsChange)[]).filter((key): key is WordedField => key !== "name" && key !== "paused");

function fieldWords(key: WordedField): string {
  const label = deviceSettingLabels[key];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function valueWords(key: WordedField, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === 0 && (key === "maxSendKbps" || key === "maxRecvKbps")) return "unlimited";
  if (value === 0 && key === "numConnections") return "Syncthing's choice";
  if (key === "maxSendKbps" || key === "maxRecvKbps") return `${value} KiB/s`;
  return String(value);
}

function renameWords(deviceName: string, name: string): string {
  return name.trim() ? `renamed device ${deviceName} to ${name}` : `removed the name of device ${deviceName}`;
}

/** What a device edit changed, in words: `pc: renamed device dashboard-test-peer to backup; compression always`. */
export function deviceEditText(nodeName: string, deviceName: string, change: DeviceSettingsChange): string {
  const fields = wordedFields.filter((key) => key in change).map((key) => `${fieldWords(key)} ${valueWords(key, change[key])}`);
  const lead = change.name !== undefined ? renameWords(deviceName, change.name) : change.paused !== undefined ? `${change.paused ? "paused" : "resumed"} device ${deviceName}` : `changed device ${deviceName}`;
  const pausedToo = change.name !== undefined && change.paused !== undefined ? [change.paused ? "paused" : "resumed"] : [];
  const details = [...pausedToo, ...fields];
  return [`${nodeName}: ${lead}`, ...details].join("; ");
}

export interface DeviceEdit {
  settings: DeviceSettings;
  note: WriteNote;
}

/**
 * Sends exactly the fields of `change` to the node's Syncthing, so a field the person did not touch
 * is never written back over a change made elsewhere meanwhile.
 */
export async function editDevice(instance: ResolvedInstance, deviceId: string, change: unknown): Promise<DeviceEdit> {
  const local = requireLocal(instance);
  const problem = deviceChangeProblem(change);
  if (problem) throw new RequestError(400, problem);
  const valid = change as DeviceSettingsChange;
  const before = await configuredDevice(local, deviceId);
  const deviceName = deviceDisplayName(typeof before.name === "string" ? before.name : "", deviceId);
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: deviceEditText(local.name, deviceName, valid) };
  await callSyncthing(local, (client) => client.request("PATCH", `/config/devices/${encodeURIComponent(deviceId)}`, valid));
  return { settings: await settingsAfter(local, deviceId, { ...before, ...valid }), note };
}

/**
 * The device as it now stands.
 * @implNote The change is already written; a node that stops answering now (Syncthing restarts after
 * some changes) must not turn it into "not saved", so the answer is then the change laid over the device as read before.
 */
async function settingsAfter(instance: LocalInstance, deviceId: string, expected: SyncthingObject): Promise<DeviceSettings> {
  try {
    return deviceSettings(await configuredDevice(instance, deviceId));
  } catch {
    return deviceSettings(expected);
  }
}

function decodedSegment(segment: string, what: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid ${what}`);
  }
}

export interface DeviceRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
}

const liveSources: DeviceRouteSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function deviceRoutes(sources: DeviceRouteSources = liveSources): AnyRoute[] {
  const pattern = /^\/api\/nodes\/([^/]+)\/devices\/([^/]+)$/;
  const target = async ([nodeId, deviceId]: string[]) => ({ instance: await sources.resolve(decodedSegment(nodeId, "node ID")), deviceId: decodedSegment(deviceId, "device ID") });
  return [
    {
      method: "GET",
      pattern,
      handle: async ({ response, params }) => {
        const { instance, deviceId } = await target(params);
        sendJson(response, 200, await readDeviceSettings(instance, deviceId));
      },
    },
    {
      method: "PATCH",
      pattern,
      write: async ({ request, response, params }) => {
        const { instance, deviceId } = await target(params);
        const edit = await editDevice(instance, deviceId, await readBody(request));
        sendJson(response, 200, edit.settings);
        return edit.note;
      },
    },
  ];
}
