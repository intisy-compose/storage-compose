import type { GeneralSettingsChange } from "./types.js";

/** What rewrites some of a node's Syncthing settings each time it starts that Syncthing. */
export type SettingsKeeper = "host-agent" | "nodes-service";

/**
 * The settings each keeper rewrites at every start: keys of Syncthing's options, and `deviceName` for the node's own device entry.
 * @implNote Mirrors `Set-SyncthingConfig` in windows/syncthing.ps1 and `prepare_home` in images/nodes/nodes.sh; a value saved here
 * would be undone at the keeper's next start, which a one-click restart triggers, so a change to either script is made here too.
 */
export const keeperManagedKeys: Record<SettingsKeeper, readonly string[]> = {
  "host-agent": [
    "listenAddresses",
    "globalAnnounceEnabled",
    "localAnnounceEnabled",
    "relaysEnabled",
    "natEnabled",
    "urAccepted",
    "autoUpgradeIntervalH",
    "crashReportingEnabled",
    "startBrowser",
    "deviceName",
  ],
  "nodes-service": ["listenAddresses"],
};

const keeperNames: Record<SettingsKeeper, string> = { "host-agent": "the host agent", "nodes-service": "the nodes service" };

/** The keeper-table key each general setting is stored under. */
export const generalSettingKeys: Record<keyof GeneralSettingsChange, string> = {
  deviceName: "deviceName",
  minHomeDiskFree: "minHomeDiskFree",
  usageReporting: "urAccepted",
  crashReportingEnabled: "crashReportingEnabled",
};

export function isKeeperManaged(keeper: SettingsKeeper | null, key: string): boolean {
  return keeper !== null && keeperManagedKeys[keeper].includes(key);
}

export function keeperManagedText(keeper: SettingsKeeper): string {
  return `set by ${keeperNames[keeper]} at each start`;
}

/**
 * Why a change naming these fields cannot be made on the node, or null: `Relays, NAT traversal: set by the host agent at each start, so not changed here`.
 * `keyOf` gives a field's key in the keeper table, `nameOf` its words.
 */
export function keeperProblem(
  keeper: SettingsKeeper | null,
  fields: readonly string[],
  nameOf: (field: string) => string = (field) => field,
  keyOf: (field: string) => string = (field) => field,
): string | null {
  const managed = fields.filter((field) => isKeeperManaged(keeper, keyOf(field)));
  return keeper && managed.length ? `${managed.map(nameOf).join(", ")}: ${keeperManagedText(keeper)}, so not changed here` : null;
}

/** What an edit applied to the whole host left out on one node: `left out Relays: set by the host agent at each start`. */
export function keeperLeftOutText(keeper: SettingsKeeper, names: readonly string[]): string {
  return `left out ${names.join(", ")}: ${keeperManagedText(keeper)}`;
}
