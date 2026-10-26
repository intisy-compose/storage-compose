import { deviceSettingLabels, shareFoldersLabel } from "./api/deviceText.js";
import type { DeviceCompression, DeviceSettings, DeviceSettingsChange, InstanceGui, InstanceOptions } from "./api/types.js";

type SyncthingObject = Record<string, unknown>;

/** @implNote Matches `encryptionPassword` too, the folder secret a device's share is encrypted with. */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "apikey" || lower.endsWith("password");
}

/** A copy of a Syncthing answer without any API key or password, however deep. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isSecretKey(key)).map(([key, entry]) => [key, redactConfig(entry)]));
}

function bool(value: unknown): boolean {
  return value === true;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** @implNote Built field by field, so nothing Syncthing adds later reaches the page. */
export function instanceOptions(options: SyncthingObject, deviceName: string): InstanceOptions {
  const minHomeDiskFree = (options.minHomeDiskFree ?? {}) as SyncthingObject;
  return {
    deviceName,
    listenAddresses: strings(options.listenAddresses),
    globalAnnounceEnabled: bool(options.globalAnnounceEnabled),
    localAnnounceEnabled: bool(options.localAnnounceEnabled),
    globalAnnounceServers: strings(options.globalAnnounceServers),
    relaysEnabled: bool(options.relaysEnabled),
    natEnabled: bool(options.natEnabled),
    maxSendKbps: count(options.maxSendKbps),
    maxRecvKbps: count(options.maxRecvKbps),
    limitBandwidthInLan: bool(options.limitBandwidthInLan),
    minHomeDiskFree: { value: count(minHomeDiskFree.value), unit: text(minHomeDiskFree.unit) || "%" },
    urAccepted: count(options.urAccepted),
    crashReportingEnabled: bool(options.crashReportingEnabled),
    reconnectionIntervalS: count(options.reconnectionIntervalS),
    alwaysLocalNets: strings(options.alwaysLocalNets),
  };
}

export function instanceGui(gui: SyncthingObject): InstanceGui {
  return { address: text(gui.address), useTLS: bool(gui.useTLS), authMode: text(gui.authMode), user: text(gui.user), managedBy: "stack" };
}

const compressions: readonly DeviceCompression[] = ["metadata", "always", "never"];

function compression(value: unknown): DeviceCompression {
  return compressions.includes(value as DeviceCompression) ? (value as DeviceCompression) : "metadata";
}

/** One entry of `/rest/config/devices`, field by field, so nothing Syncthing adds later reaches the page. */
export function deviceSettings(device: SyncthingObject): DeviceSettings {
  return {
    deviceId: text(device.deviceID),
    name: text(device.name),
    addresses: strings(device.addresses),
    compression: compression(device.compression),
    introducer: bool(device.introducer),
    autoAcceptFolders: bool(device.autoAcceptFolders),
    paused: bool(device.paused),
    untrusted: bool(device.untrusted),
    allowedNetworks: strings(device.allowedNetworks),
    maxSendKbps: count(device.maxSendKbps),
    maxRecvKbps: count(device.maxRecvKbps),
    numConnections: count(device.numConnections),
  };
}

function isSame(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** The fields of `after` that differ from `before`; lists compare by content. */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => !isSame(before[key as keyof T], value))) as Partial<T>;
}

const addressSchemes = new Set(["tcp", "tcp4", "tcp6", "quic", "quic4", "quic6", "relay"]);

/** Why Syncthing could not dial this device address, or null when it can. */
export function addressProblem(address: string): string | null {
  if (address === "dynamic") return null;
  const parsed = /^([a-z0-9]+):\/\/([^/?#\s]+)[^\s]*$/i.exec(address);
  if (!parsed || !addressSchemes.has(parsed[1].toLowerCase())) return `${address || "an empty address"} is not dynamic or a tcp://, quic:// or relay:// address`;
  if (parsed[1].toLowerCase() === "relay" && !/[?&]id=[^&#]+/.test(address)) return `${address} names no relay: a relay:// address needs ?id=<the relay's device ID>`;
  return null;
}

/** Why `value` cannot be sent as the setting labelled `label`, as a sentence, or null when it can. */
type FieldCheck = (value: unknown, label: string) => string | null;

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const booleanField: FieldCheck = (value, label) => (typeof value === "boolean" ? null : `${label} must be on or off`);
const wholeNumberField: FieldCheck = (value, label) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? null : `${label} must be a whole number, 0 or more`);

function addressesCheck(value: unknown, label: string): string | null {
  if (!isStringList(value)) return `${label} must be a list of addresses`;
  if (value.length === 0) return `${label} needs at least one address, or dynamic`;
  return value.map(addressProblem).find((problem) => problem !== null) ?? null;
}

const deviceFieldChecks: Record<keyof DeviceSettingsChange, FieldCheck> = {
  name: (value, label) => (typeof value === "string" ? null : `${label} must be text`),
  addresses: addressesCheck,
  compression: (value, label) => (compressions.includes(value as DeviceCompression) ? null : `${label} must be ${compressions.join(", ")}`),
  introducer: booleanField,
  autoAcceptFolders: booleanField,
  paused: booleanField,
  untrusted: booleanField,
  allowedNetworks: (value, label) => (isStringList(value) && value.every((entry) => entry.trim() !== "") ? null : `${label} must be a list of networks`),
  maxSendKbps: wholeNumberField,
  maxRecvKbps: wholeNumberField,
  numConnections: wholeNumberField,
};

function settingProblem(key: string, value: unknown): string | null {
  if (key === "deviceId") return "the device ID cannot be changed";
  if (!Object.hasOwn(deviceFieldChecks, key)) return `${key} is not a device setting`;
  const field = key as keyof DeviceSettingsChange;
  return deviceFieldChecks[field](value, deviceSettingLabels[field]);
}

function firstSettingProblem(settings: object): string | null {
  for (const [key, value] of Object.entries(settings)) {
    const problem = settingProblem(key, value);
    if (problem) return problem;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a device change cannot be sent to Syncthing as it is, or null when it can; a setting is named by its label in the form. */
export function deviceChangeProblem(change: unknown): string | null {
  if (!isPlainObject(change) || Object.keys(change).length === 0) return "nothing to change";
  return firstSettingProblem(change);
}

/** Why a new device cannot be added as it is, or null when it can; whether the ID is one is Syncthing's to say. */
export function newDeviceProblem(body: unknown): string | null {
  if (!isPlainObject(body)) return "the request is not a device";
  const { deviceId, shareFolders, ...settings } = body;
  if (typeof deviceId !== "string" || !deviceId.trim()) return "the device ID is missing";
  if (shareFolders !== undefined && !isStringList(shareFolders)) return `${shareFoldersLabel} must be a list of folder IDs`;
  return firstSettingProblem(settings);
}
