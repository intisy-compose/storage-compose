import { deviceSettingLabels, shareFoldersLabel } from "./api/deviceText.js";
import { connectionOptionLabels, discoveryServerProblem, listenAddressProblem, perNodeListenText } from "./api/optionsText.js";
import { type ConnectionOptionKey, type DeviceCompression, type DeviceSettings, type DeviceSettingsChange, type DiskFreeUnit, type FolderSettingsChange, type FolderSharingChange, type FolderType, type InstanceGui, type InstanceOptions, type PullOrder, type VersioningType, diskFreeUnits, editableFolderTypes, folderSettingLabels, folderTypeTexts, pullOrderTexts, sharePassword } from "./api/types.js";
import { type VersioningParam, cleanupIntervalLabel, externalVersioningRefusal, offeredVersioningTypes, versioningParamKeys, versioningParamLabels, versioningTypeTexts, versionsPathLabel } from "./api/versioningText.js";

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

/** @implNote Object keys are sorted, so `{ value, unit }` from the form matches Syncthing's `{ unit, value }`. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
}

function isSame(first: unknown, second: unknown): boolean {
  return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second));
}

/** The fields of `after` that differ from `before`; lists and objects compare by content. */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => !isSame(before[key as keyof T], value))) as Partial<T>;
}

/** Whether every field of `change` already has its value in `current`, as Syncthing answers it. */
export function isChangeInPlace(current: object, change: object): boolean {
  return Object.entries(change).every(([key, value]) => isSame((current as Record<string, unknown>)[key], value));
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
  if (settings.untrusted === true && shareFolders?.length) return "an untrusted device is shared a folder only with an encryption password: add it, then share from its Folders list";
  return firstSettingProblem(settings);
}

const folderTypeChoices = editableFolderTypes.map((type) => folderTypeTexts[type]).join(", ");

function minDiskFreeCheck(value: unknown, label: string): string | null {
  const free = isPlainObject(value) ? value : {};
  if (typeof free.value !== "number" || !Number.isFinite(free.value) || free.value < 0) return `${label} must be a number, 0 or more`;
  if (!diskFreeUnits.includes(free.unit as DiskFreeUnit)) return `${label} must be in ${diskFreeUnits.join(", ")}`;
  if (free.unit === "%" && free.value > 100) return `${label} cannot be more than 100 %`;
  return Object.keys(free).length === 2 ? null : `${label} takes only a value and a unit`;
}

const shareKeys = new Set(["deviceId", "encryptionPassword"]);

function isShareShape(value: unknown): value is { deviceId: string; encryptionPassword?: unknown } {
  return isPlainObject(value) && Object.keys(value).every((key) => shareKeys.has(key)) && typeof value.deviceId === "string" && value.deviceId.trim() !== "";
}

function isSharingShape(value: unknown): value is { share?: { deviceId: string; encryptionPassword?: unknown }[]; unshare?: string[] } {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "share" && key !== "unshare")) return false;
  const { share = [], unshare = [] } = value;
  return Array.isArray(share) && share.every(isShareShape) && isStringList(unshare) && unshare.every((deviceId) => deviceId.trim() !== "");
}

function sharingCheck(value: unknown, label: string): string | null {
  if (!isSharingShape(value)) return `${label} must say which devices to share with or stop sharing with`;
  const { share = [], unshare = [] } = value;
  if (share.some((entry) => entry.encryptionPassword !== undefined && typeof entry.encryptionPassword !== "string")) return "an encryption password must be text";
  if (share.length + unshare.length === 0) return `${label} names no device`;
  return share.some((entry) => unshare.includes(entry.deviceId)) ? `${label} cannot both share with and stop sharing with the same device` : null;
}

/** One entry of a folder's `devices` in Syncthing's config. */
export interface FolderDeviceEntry {
  deviceID: string;
  introducedBy?: string;
  encryptionPassword?: string;
}

/** The part of `change` that changes `current`: devices not yet shared to share, shared ones to unshare; the first entry of a device counts. */
export function effectiveSharing(current: readonly FolderDeviceEntry[], change: FolderSharingChange): Required<FolderSharingChange> {
  const shared = new Set(current.map((entry) => entry.deviceID));
  const share = (change.share ?? []).filter((entry, index, all) => !shared.has(entry.deviceId) && all.findIndex((other) => other.deviceId === entry.deviceId) === index);
  return { share, unshare: [...new Set(change.unshare ?? [])].filter((deviceId) => shared.has(deviceId)) };
}

/** The folder's device list after `sharing`: every other entry exactly as Syncthing has it, its password included, as Syncthing replaces the whole list. */
export function sharedDevices(current: readonly FolderDeviceEntry[], sharing: FolderSharingChange): FolderDeviceEntry[] {
  const unshared = new Set(sharing.unshare ?? []);
  const added = (sharing.share ?? []).map((entry) => {
    const password = sharePassword(entry.encryptionPassword);
    return password === null ? { deviceID: entry.deviceId } : { deviceID: entry.deviceId, encryptionPassword: password };
  });
  return [...current.filter((entry) => !unshared.has(entry.deviceID)), ...added];
}

const versioningKeys = ["cleanupIntervalS", "fsPath", "params", "type"];
/** Each numeric param as Syncthing keeps it, named with its unit there: the form shows maximum age in days, the API takes seconds. */
const numericParams: Record<Exclude<VersioningParam, "command">, { name: string; minimum: number }> = {
  cleanoutDays: { name: "Clean out after, in days,", minimum: 0 },
  keep: { name: "Versions kept", minimum: 1 },
  maxAge: { name: "Maximum age, in seconds,", minimum: 0 },
};

function paramProblem(key: VersioningParam, value: unknown): string | null {
  const { name, minimum } = numericParams[key as Exclude<VersioningParam, "command">];
  const isWholeNumberText = typeof value === "string" && /^\d+$/.test(value) && Number(value) >= minimum;
  return isWholeNumberText ? null : `${name} must be a whole number, ${minimum} or more`;
}

function paramsProblem(type: VersioningType, params: Record<string, unknown>): string | null {
  const expected = versioningParamKeys[type];
  const hasExactKeys = Object.keys(params).length === expected.length && expected.every((key) => Object.hasOwn(params, key));
  if (!hasExactKeys) return expected.length ? `${versioningTypeTexts[type]} versioning takes ${expected.map((key) => versioningParamLabels[key]).join(", ")}` : "no versioning takes no settings";
  return expected.map((key) => paramProblem(key, params[key])).find((problem) => problem !== null) ?? null;
}

/**
 * A versioning change is Syncthing's whole object with exactly its type's params, each a string as Syncthing keeps them.
 * @implNote Whole, because Syncthing 2.1.6 resets a cleanup interval a PATCH leaves out to 3600.
 */
function versioningCheck(value: unknown, label: string): string | null {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== versioningKeys.join() || !isPlainObject(value.params)) return `${label} must give its type, settings, cleanup interval and versions path`;
  if (value.type === "external") return externalVersioningRefusal;
  if (!offeredVersioningTypes.includes(value.type as VersioningType)) return `${label} must be ${offeredVersioningTypes.map((type) => versioningTypeTexts[type]).join(", ")}`;
  return paramsProblem(value.type as VersioningType, value.params) ?? wholeNumberField(value.cleanupIntervalS, cleanupIntervalLabel) ?? (typeof value.fsPath === "string" ? null : `${versionsPathLabel} must be text`);
}

const folderFieldChecks: Record<keyof FolderSettingsChange, FieldCheck> = {
  label: (value, label) => (typeof value === "string" ? null : `${label} must be text`),
  path: (value, label) => (typeof value === "string" && value.trim() ? null : `${label} is missing`),
  type: (value, label) => (editableFolderTypes.includes(value as FolderType) ? null : `${label} must be ${folderTypeChoices}`),
  rescanIntervalS: wholeNumberField,
  fsWatcherEnabled: booleanField,
  fsWatcherDelayS: (value, label) => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? null : `${label} must be a whole number of seconds, 1 or more`),
  ignorePerms: booleanField,
  order: (value, label) => (Object.hasOwn(pullOrderTexts, value as PullOrder) ? null : `${label} must be ${Object.values(pullOrderTexts).join(", ")}`),
  minDiskFree: minDiskFreeCheck,
  maxConflicts: (value, label) => (typeof value === "number" && Number.isInteger(value) && value >= -1 ? null : `${label} must be a whole number, or -1 for unlimited`),
  syncOwnership: booleanField,
  syncXattrs: booleanField,
  versioning: versioningCheck,
  devices: sharingCheck,
};

function folderSettingProblem(key: string, value: unknown): string | null {
  if (key === "id") return "the folder ID cannot be changed";
  if (!Object.hasOwn(folderFieldChecks, key)) return `${key} is not a folder setting this edit changes`;
  const field = key as keyof FolderSettingsChange;
  return folderFieldChecks[field](value, folderSettingLabels[field]);
}

function listenAddressesCheck(value: unknown, label: string): string | null {
  if (!isStringList(value)) return `${label} must be a list of addresses`;
  if (value.length === 0) return `${label} needs at least one address, or default`;
  return value.map(listenAddressProblem).find((problem) => problem !== null) ?? null;
}

function discoveryServersCheck(value: unknown, label: string): string | null {
  if (!isStringList(value)) return `${label} must be a list of servers`;
  return value.map(discoveryServerProblem).find((problem) => problem !== null) ?? null;
}

const optionFieldChecks: Record<ConnectionOptionKey, FieldCheck> = {
  listenAddresses: listenAddressesCheck,
  maxRecvKbps: wholeNumberField,
  maxSendKbps: wholeNumberField,
  limitBandwidthInLan: booleanField,
  natEnabled: booleanField,
  localAnnounceEnabled: booleanField,
  globalAnnounceEnabled: booleanField,
  globalAnnounceServers: discoveryServersCheck,
  relaysEnabled: booleanField,
};

function optionProblem(key: string, value: unknown): string | null {
  if (!Object.hasOwn(optionFieldChecks, key)) return `${key} is not a connection option`;
  const field = key as ConnectionOptionKey;
  return optionFieldChecks[field](value, connectionOptionLabels[field]);
}

/** Why a connection options change cannot be sent as it is, or null when it can; one for every node of the host never carries listen addresses. */
export function optionsChangeProblem(change: unknown, applyToHost: boolean): string | null {
  if (!isPlainObject(change) || Object.keys(change).length === 0) return "nothing to change";
  if (applyToHost && Object.hasOwn(change, "listenAddresses")) return perNodeListenText;
  for (const [key, value] of Object.entries(change)) {
    const problem = optionProblem(key, value);
    if (problem) return problem;
  }
  return null;
}

/** Why a folder change cannot be sent to Syncthing as it is, or null when it can; a setting is named by its label in the form. */
export function folderChangeProblem(change: unknown): string | null {
  if (!isPlainObject(change) || Object.keys(change).length === 0) return "nothing to change";
  for (const [key, value] of Object.entries(change)) {
    const problem = folderSettingProblem(key, value);
    if (problem) return problem;
  }
  return null;
}
