import type { InstanceGui, InstanceOptions } from "./api/types.js";

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
