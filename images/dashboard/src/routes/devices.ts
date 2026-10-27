import type { ServerResponse } from "node:http";
import { deviceDisplayName, deviceSettingLabels, shortDeviceId } from "../api/deviceText.js";
import type { AddedDevice, DeviceIdCheck, DeviceSettings, DeviceSettingsChange, NearbyDevice, NewDevice, RemoveDeviceBody } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, forwardRead, isArrayInstance, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import { SyncthingError } from "../syncthing.js";
import { deviceChangeProblem, deviceSettings, isChangeInPlace, newDeviceProblem, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

async function configuredDevices(instance: LocalInstance): Promise<SyncthingObject[]> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingObject[] | null>("GET", "/config/devices"))) ?? [];
}

async function configuredDevice(instance: LocalInstance, deviceId: string): Promise<SyncthingObject> {
  const device = (await configuredDevices(instance)).find((entry) => entry.deviceID === deviceId);
  if (!device) throw new RequestError(404, `${instance.name} has no device ${shortDeviceId(deviceId)}`);
  return device;
}

function nodePath(nodeId: string, rest: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/${rest}`;
}

function devicePath(nodeId: string, deviceId: string): string {
  return nodePath(nodeId, `devices/${encodeURIComponent(deviceId)}`);
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

function settingsWords(change: DeviceSettingsChange): string[] {
  return wordedFields.filter((key) => key in change).map((key) => `${fieldWords(key)} ${valueWords(key, change[key])}`);
}

function renameWords(deviceName: string, name: string): string {
  return name.trim() ? `renamed device ${deviceName} to ${name}` : `removed the name of device ${deviceName}`;
}

/** What a device edit changed, in words: `pc: renamed device dashboard-test-peer to backup; compression always`. */
export function deviceEditText(nodeName: string, deviceName: string, change: DeviceSettingsChange): string {
  const lead = change.name !== undefined ? renameWords(deviceName, change.name) : change.paused !== undefined ? `${change.paused ? "paused" : "resumed"} device ${deviceName}` : `changed device ${deviceName}`;
  const pausedToo = change.name !== undefined && change.paused !== undefined ? [change.paused ? "paused" : "resumed"] : [];
  const details = [...pausedToo, ...settingsWords(change)];
  return [`${nodeName}: ${lead}`, ...details].join("; ");
}

/** The device settings that let Syncthing add an offered folder, or share folders with an introduced device, by itself. */
const arrayLockedSettings = ["introducer", "autoAcceptFolders"] as const;

/**
 * Why the change may not be made on this node, or null: on an array neither setting is turned on.
 * @implNote Either would let Syncthing add or share an array's folders with nothing typed (`arrayConfirmProblem`); turning them off stays allowed.
 */
function arrayAutomationProblem(instance: LocalInstance, change: DeviceSettingsChange): string | null {
  if (!isArrayInstance(instance)) return null;
  const turnedOn = arrayLockedSettings.find((key) => change[key] === true);
  return turnedOn ? `${deviceSettingLabels[turnedOn]} stays off on ${instance.name}, an array: Syncthing would then add or share its folders with nothing typed` : null;
}

/** On an array a new device starts with both locked settings off, whatever the node's own defaults say. */
function arrayLockedOff(instance: LocalInstance): SyncthingObject {
  return isArrayInstance(instance) ? Object.fromEntries(arrayLockedSettings.map((key) => [key, false])) : {};
}

export interface DeviceEdit {
  settings: DeviceSettings;
  note: WriteNote;
}

/**
 * Sends exactly the fields of `change` to the node's Syncthing, so a field the person did not touch
 * is never written back over a change made elsewhere meanwhile.
 */
export async function editDevice(instance: ResolvedInstance, deviceId: string, change: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<DeviceEdit> {
  const local = requireLocal(instance);
  const problem = deviceChangeProblem(change) ?? arrayAutomationProblem(local, change as DeviceSettingsChange);
  if (problem) throw new RequestError(400, problem);
  const valid = change as DeviceSettingsChange;
  const before = await configuredDevice(local, deviceId);
  const deviceName = deviceDisplayName(typeof before.name === "string" ? before.name : "", deviceId);
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: deviceEditText(local.name, deviceName, valid) };
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", `/config/devices/${encodeURIComponent(deviceId)}`, valid),
    async () => isChangeInPlace(await configuredDevice(local, deviceId), valid),
    readBackDelaysMs,
  );
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

/** Syncthing's reading of a typed device ID: its canonical form, or Syncthing's own reason it is none, which quotes the ID. */
async function readTypedDeviceId(instance: LocalInstance, typed: string): Promise<DeviceIdCheck> {
  const answer = asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", `/svc/deviceid?id=${encodeURIComponent(typed)}`)));
  if (typeof answer.id === "string" && answer.id) return { deviceId: answer.id, problem: null };
  return { deviceId: null, problem: typeof answer.error === "string" && answer.error ? answer.error : `${typed} is not a device ID` };
}

function knownProblem(instance: LocalInstance, devices: SyncthingObject[], deviceId: string): string | null {
  const known = devices.find((device) => device.deviceID === deviceId);
  return known ? `${instance.name} already has device ${deviceDisplayName(typeof known.name === "string" ? known.name : "", deviceId)}` : null;
}

/**
 * Whether `typed` can be added to the node: the ID as Syncthing reads it, or Syncthing's reason, or that the node has it already.
 * @implNote The add form's reads, like the add, are this host's nodes' only: another host's node gets its devices on that host's dashboard.
 */
export async function checkDeviceId(instance: ResolvedInstance, typed: string): Promise<DeviceIdCheck> {
  const local = requireLocal(instance);
  if (!typed.trim()) return { deviceId: null, problem: "the device ID is missing" };
  const reading = await readTypedDeviceId(local, typed.trim());
  if (!reading.deviceId) return reading;
  return { deviceId: reading.deviceId, problem: knownProblem(local, await configuredDevices(local), reading.deviceId) };
}

async function syncthingDefaults(instance: LocalInstance): Promise<SyncthingObject> {
  return asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", "/config/defaults/device")));
}

/** A new device's settings as the node's Syncthing fills them in. */
export async function readDeviceDefaults(instance: ResolvedInstance): Promise<DeviceSettings> {
  return deviceSettings(await syncthingDefaults(requireLocal(instance)));
}

function addressList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((address): address is string => typeof address === "string") : [];
}

/** @implNote Syncthing 2 answers each discovered device as `{ addresses }`, older ones as the bare list. */
function discoveredAddresses(value: unknown): string[] {
  return addressList(Array.isArray(value) ? value : asObject(value).addresses);
}

function byDeviceId(first: NearbyDevice, second: NearbyDevice): number {
  return first.deviceId.localeCompare(second.deviceId);
}

/** Devices the node's Syncthing found by discovery and has not configured, to offer as the new device. */
export async function nearbyDevices(instance: ResolvedInstance): Promise<NearbyDevice[]> {
  const local = requireLocal(instance);
  const [discovered, configured] = await Promise.all([callSyncthing(local, (client) => client.request<unknown>("GET", "/system/discovery")), configuredDevices(local)]);
  const known = new Set(configured.map((device) => device.deviceID));
  return Object.entries(asObject(discovered))
    .filter(([deviceId]) => !known.has(deviceId))
    .map(([deviceId, value]) => ({ deviceId, addresses: discoveredAddresses(value) }))
    .sort(byDeviceId);
}

type Sharing = Pick<AddedDevice, "shared" | "notShared">;

async function shareWithDevice(instance: LocalInstance, deviceId: string, folderIds: string[]): Promise<Sharing> {
  const sharing: Sharing = { shared: [], notShared: [] };
  for (const folderId of folderIds) {
    try {
      await callSyncthing(instance, (client) => client.shareFolder(folderId, deviceId));
      sharing.shared.push(folderId);
    } catch (error) {
      sharing.notShared.push({ folderId, problem: (error as Error).message });
    }
  }
  return sharing;
}

/** What an add did, in words: `pc: added device laptop; introducer on; shared documents`. */
export function deviceAddText(nodeName: string, deviceName: string, change: DeviceSettingsChange, sharing: Sharing): string {
  const details = [
    ...(change.paused ? ["paused"] : []),
    ...settingsWords(change),
    ...(sharing.shared.length ? [`shared ${sharing.shared.join(", ")}`] : []),
    ...sharing.notShared.map((entry) => `not shared ${entry.folderId} (${entry.problem})`),
  ];
  return [`${nodeName}: added device ${deviceName}`, ...details].join("; ");
}

export interface DeviceAddition {
  added: AddedDevice;
  note: WriteNote;
}

interface AddPlan {
  deviceId: string;
  /** The whole device as it is sent: Syncthing's defaults with the person's settings over them. */
  config: SyncthingObject;
  change: DeviceSettingsChange;
  folderIds: string[];
}

/** Everything an add needs, read and checked before anything is written. */
async function planAdd(instance: LocalInstance, request: NewDevice): Promise<AddPlan> {
  const { deviceId: typed, shareFolders = [], ...change } = request;
  const reading = await readTypedDeviceId(instance, typed.trim());
  if (!reading.deviceId) throw new RequestError(400, reading.problem ?? `${typed} is not a device ID`);
  const deviceId = reading.deviceId;
  const [devices, folders, defaults] = await Promise.all([configuredDevices(instance), callSyncthing(instance, (client) => client.folders()), syncthingDefaults(instance)]);
  const known = knownProblem(instance, devices, deviceId);
  if (known) throw new RequestError(409, known);
  const folderIds = [...new Set(shareFolders)];
  const missing = folderIds.find((folderId) => !(folders ?? []).some((folder) => folder.id === folderId));
  if (missing) throw new RequestError(400, `${instance.name} has no folder ${missing}`);
  return { deviceId, config: { ...defaults, ...change, ...arrayLockedOff(instance), deviceID: deviceId }, change, folderIds };
}

/** @implNote A share on an array needs the folder ID typed (`arrayConfirmProblem`), which the add's list of folders has no place for. */
function arraySharesProblem(instance: LocalInstance, request: NewDevice): string | null {
  if (!isArrayInstance(instance) || !request.shareFolders?.length) return null;
  return `on ${instance.name}, an array, a folder is shared only from its own settings, where its ID is typed: add the device, then share each folder there`;
}

/**
 * Adds a device to the node's Syncthing, every setting the person left out taken from Syncthing's own
 * defaults, then shares the chosen folders with it.
 * @implNote A share that fails once the device is added does not undo the add: the answer and the
 * Activity entry name the folders that were not shared.
 */
export async function addDevice(instance: ResolvedInstance, body: unknown): Promise<DeviceAddition> {
  const local = requireLocal(instance);
  const problem = newDeviceProblem(body) ?? arraySharesProblem(local, body as NewDevice) ?? arrayAutomationProblem(local, body as NewDevice);
  if (problem) throw new RequestError(400, problem);
  const plan = await planAdd(local, body as NewDevice);
  await callSyncthing(local, (client) => client.request("POST", "/config/devices", plan.config));
  const sharing = await shareWithDevice(local, plan.deviceId, plan.folderIds);
  const deviceName = deviceDisplayName(typeof plan.config.name === "string" ? plan.config.name : "", plan.deviceId);
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: deviceAddText(local.name, deviceName, plan.change, sharing) };
  return { added: { device: await settingsAfter(local, plan.deviceId, plan.config), ...sharing }, note };
}

function nameOf(device: SyncthingObject, deviceId: string): string {
  return deviceDisplayName(typeof device.name === "string" ? device.name : "", deviceId);
}

interface OtherDevice {
  device: SyncthingObject;
  name: string;
}

/** The configured device an action is for; the node's own device cannot be paused or removed, as Syncthing has no connection to it. */
async function otherDevice(instance: LocalInstance, deviceId: string, done: string): Promise<OtherDevice> {
  const [device, ownId] = await Promise.all([configuredDevice(instance, deviceId), callSyncthing(instance, (client) => client.myId())]);
  const name = nameOf(device, deviceId);
  if (deviceId === ownId) throw new RequestError(409, `${name} is ${instance.name}'s own device; it cannot be ${done}`);
  return { device, name };
}

function pauseVerb(paused: boolean): string {
  return paused ? "pause" : "resume";
}

function pausedWord(paused: boolean): string {
  return paused ? "paused" : "resumed";
}

/** Pauses or resumes one device through Syncthing's own pause, as its page does. */
export async function pauseDevice(instance: ResolvedInstance, deviceId: string, paused: boolean): Promise<DeviceEdit> {
  const local = requireLocal(instance);
  const { device, name } = await otherDevice(local, deviceId, pausedWord(paused));
  await callSyncthing(local, (client) => client.request("POST", `/system/${pauseVerb(paused)}?device=${encodeURIComponent(deviceId)}`));
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: deviceEditText(local.name, name, { paused }) };
  return { settings: await settingsAfter(local, deviceId, { ...device, paused }), note };
}

export interface NodePause {
  /** Every device of the node but its own, as it now stands. */
  devices: DeviceSettings[];
  note: WriteNote | NothingWritten;
}

async function otherDevices(instance: LocalInstance): Promise<SyncthingObject[]> {
  const [devices, ownId] = await Promise.all([configuredDevices(instance), callSyncthing(instance, (client) => client.myId())]);
  return devices.filter((device) => device.deviceID !== ownId);
}

function isNotAnswering(error: Error): boolean {
  return error instanceof RequestError && error.status === 503;
}

/**
 * The devices as read before the pause, with it laid over them.
 * @implNote The pause is already written, so any failure to read them back still reports it; one other than a node that stops answering is logged by name.
 */
function devicesAsPaused(instance: LocalInstance, before: SyncthingObject[], paused: boolean, error: Error): SyncthingObject[] {
  if (!isNotAnswering(error)) console.error(`${instance.name}: devices not read back after the ${pauseVerb(paused)}: ${error.message}`);
  return before.map((device) => ({ ...device, paused }));
}

/**
 * Pauses or resumes every device of the node at once, Syncthing's pause without a device.
 * @implNote The devices are read before the write so a node that stops answering after it still reports what it paused.
 */
export async function pauseNode(instance: ResolvedInstance, paused: boolean): Promise<NodePause> {
  const local = requireLocal(instance);
  const before = await otherDevices(local);
  if (before.length === 0) return { devices: [], note: { nothingWritten: true } };
  await callSyncthing(local, (client) => client.request("POST", `/system/${pauseVerb(paused)}`));
  const after = await otherDevices(local).catch((error: Error) => devicesAsPaused(local, before, paused, error));
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: ${pausedWord(paused)} every device` };
  return { devices: after.map(deviceSettings), note };
}

/**
 * Removes a device from the node's Syncthing once its name, as the dashboard shows it, is typed.
 * @implNote The typed name is the confirmation, as a destructive array action repeats the drive's role: a stray click cannot stop a node syncing with a device.
 */
export async function removeDevice(instance: ResolvedInstance, deviceId: string, body: unknown): Promise<DeviceEdit> {
  const local = requireLocal(instance);
  const { device, name } = await otherDevice(local, deviceId, "removed");
  if ((asObject(body) as Partial<RemoveDeviceBody>).confirm !== name) throw new RequestError(400, `type ${name} to confirm`);
  await callSyncthing(local, (client) => client.request("DELETE", `/config/devices/${encodeURIComponent(deviceId)}`));
  return { settings: deviceSettings(device), note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: removed device ${name}` } };
}

const maxQrTextLength = 256;

/**
 * The node's Syncthing draws the QR code, as its own page does for its device ID.
 * @implNote Cached by the browser: the same text always draws the same code, and the page re-renders every poll.
 */
async function sendQr(instance: ResolvedInstance, text: string, response: ServerResponse): Promise<void> {
  const local = requireLocal(instance);
  if (!text || text.length > maxQrTextLength) throw new RequestError(400, `the QR code's text must be 1 to ${maxQrTextLength} characters`);
  const answer = await callSyncthing(local, (client) => client.raw("GET", `/qr/?text=${encodeURIComponent(text)}`));
  if (!answer.ok) throw new SyncthingError(`GET /qr/: HTTP ${answer.status}`);
  const image = Buffer.from(await answer.arrayBuffer());
  response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
  response.end(image);
}

/** A path segment as sent, decoded; one that is not valid percent-encoding is 400. */
export function decodedSegment(segment: string, what: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid ${what}`);
  }
}

export interface DeviceRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The waits between read-backs of an edit whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: DeviceRouteSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function deviceRoutes(sources: DeviceRouteSources = liveSources): AnyRoute[] {
  const devicePattern = /^\/api\/nodes\/([^/]+)\/devices\/([^/]+)$/;
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  const target = async ([nodeId, deviceId]: string[]) => ({ instance: await node(nodeId), deviceId: decodedSegment(deviceId, "device ID") });
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/device-defaults$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await readDeviceDefaults(await node(nodeId))),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/nearby$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await nearbyDevices(await node(nodeId))),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/device-id-check$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await checkDeviceId(await node(nodeId), url.searchParams.get("id") ?? "")),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/qr$/,
      handle: async ({ response, url, params: [nodeId] }) => sendQr(await node(nodeId), url.searchParams.get("text") ?? "", response),
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/devices$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const addition = await addDevice(await node(nodeId), await readBody(request));
        sendJson(response, 201, addition.added);
        return addition.note;
      },
    },
    {
      method: "GET",
      pattern: devicePattern,
      handle: async ({ response, params }) => {
        const { instance, deviceId } = await target(params);
        sendJson(response, 200, await readDeviceSettings(instance, deviceId));
      },
    },
    {
      method: "PATCH",
      pattern: devicePattern,
      write: async ({ request, response, params }) => {
        const { instance, deviceId } = await target(params);
        const edit = await editDevice(instance, deviceId, await readBody(request), sources.readBackDelaysMs);
        sendJson(response, 200, edit.settings);
        return edit.note;
      },
    },
    {
      method: "DELETE",
      pattern: devicePattern,
      write: async ({ request, response, params }) => {
        const { instance, deviceId } = await target(params);
        const removal = await removeDevice(instance, deviceId, await readBody(request));
        sendJson(response, 200, removal.settings);
        return removal.note;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/devices\/([^/]+)\/(pause|resume)$/,
      write: async ({ response, params: [nodeId, deviceSegment, verb] }) => {
        const { instance, deviceId } = await target([nodeId, deviceSegment]);
        const edit = await pauseDevice(instance, deviceId, verb === "pause");
        sendJson(response, 200, edit.settings);
        return edit.note;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/(pause|resume)$/,
      write: async ({ response, params: [nodeId, verb] }) => {
        const pause = await pauseNode(await node(nodeId), verb === "pause");
        sendJson(response, 200, pause.devices);
        return pause.note;
      },
    },
  ];
}
