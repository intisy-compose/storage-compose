/**
 * The dashboard's HTTP contract, shared by the server (`src/`) and the page (`ui/`).
 * Sizes are bytes, rates bytes per second, times ISO 8601 strings in UTC, percentages 0 to 100.
 */
import type { SettingsKeeper } from "./keeperText.js";

/** "device" is a Syncthing device no dashboard and no join record describes, so nothing says what node it holds. */
export type NodeKind = "array" | "drive" | "folder" | "device";

/** "unknown" is a connected device whose completion could not be read. */
export type SyncState = "idle" | "syncing" | "waiting" | "error" | "offline" | "unknown";

/**
 * "frozen" is the C-24 freeze: more drives lost than parity covers, or data1 gone or read-only.
 * "absent" is an array none of whose drives is connected to its host, shown as it was last seen.
 */
export type ArrayState = "healthy" | "degraded" | "frozen" | "absent";

export type WarningLevel = "info" | "warning" | "error";

export interface HostInfo {
  name: string;
}

export interface Space {
  size: number;
  used: number;
}

/** "waiting" is a node whose own folders are done while a connected peer has not got them all yet. */
export interface NodeSync {
  state: SyncState;
  completion: number;
  lastSeen: string | null;
  /** Device IDs of the peers a "waiting" node waits for. */
  waitingFor?: string[];
}

/** "warn" is a count that rose but was accepted before; "fail" a drive the mounter holds as failing. */
export interface MemberSmart {
  state: "ok" | "warn" | "fail" | "none";
  detail: string;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  powerOnHours: number | null;
}

export interface ArrayMember {
  role: string;
  label: string;
  serial: string | null;
  size: number | null;
  used: number | null;
  asset: string | null;
  present: boolean;
  smart: MemberSmart | null;
  temperature: number | null;
  /** The mounter's word for the drive. */
  condition: "present" | "dropped" | "missing" | "failing";
  detail: string;
  /** For a member of an array that is not connected: when the mounter's last round still had it on this host. */
  lastPresent: PresenceWindow | null;
}

export interface PresenceWindow {
  since: string;
  at: string;
}

/** One stay of a drive on one host. */
export interface DriveAttachment {
  host: string;
  since: string;
  lastAt: string;
  /** When a build found the drive gone from that host, its last sighting there; null while it is attached. */
  endedAt: string | null;
  /** What the drive was there, for example `data1 of private-array` or `drive node pc`. */
  as: string;
}

export type DriveRecordKind = "array-member" | "drive-node" | "folder-node";

/** A drive and the hosts it was attached to, newest first, at most 20. */
export interface DriveRecord {
  /** `serial:<serial>`, else `member:<arrayId>-<role>` for an array member or `node:<nodeId>` for a node. */
  key: string;
  label: string;
  kind: DriveRecordKind;
  serial: string | null;
  size: number | null;
  arrayId: string | null;
  nodeId: string | null;
  attachments: DriveAttachment[];
}

/** A drive with where it is now: attached on `currentHost`, or, while attached nowhere, last on `lastHost`. */
export interface DriveSummary extends DriveRecord {
  present: boolean;
  currentHost: string | null;
  lastHost: string | null;
  lastAt: string | null;
}

export type DeviceSource = "dashboard" | "syncthing" | "join" | "history";

/** How one of this host's instances reaches a device. */
export interface InstanceConnection {
  nodeId: string;
  nodeName: string;
  connected: boolean;
  kind: ConnectionKind | null;
  address: string | null;
}

/** A computer: a host running storage-compose, keyed by its name, or another Syncthing device, keyed by its first device ID. */
export interface DeviceSummary {
  key: string;
  name: string;
  thisHost: boolean;
  online: boolean;
  /** The closest connection any instance of this host has to it now; null while none is connected and for this host. */
  connection: { kind: ConnectionKind; address: string; type: string; nodeId: string } | null;
  perInstance: InstanceConnection[];
  lastSeen: string | null;
  lastConnection: { kind: ConnectionKind; address: string | null; at: string } | null;
  deviceIds: string[];
  nodeIds: string[];
  driveKeys: string[];
  sources: DeviceSource[];
}

/**
 * `GET /api/devices`; with `?scope=local`, this host's view only, as another host's dashboard reads it.
 * In that scope other hosts are not read, so their devices read online only through a live connection.
 */
export interface DevicesResponse {
  devices: DeviceSummary[];
  drives: DriveSummary[];
}

/**
 * @implNote Read from SnapRAID itself, its content lock and the progress its wrapper records, so a job
 * started by hand shows as well as one the dashboard or the schedule started. A run that bypassed the
 * wrapper shows as kind "unknown" with progress 0 and the lock's time as its start.
 */
export interface ParityJob {
  kind: string;
  progress: number;
  startedAt: string;
}

export interface Parity {
  job: ParityJob | null;
  lastSync: string | null;
  lastScrub: string | null;
  /** Why the last sync was refused (the deletion guard), or null; offers "sync anyway". */
  refused: string | null;
  lastSyncResult: string | null;
  lastScrubResult: string | null;
}

export interface DriveCandidate {
  path: string;
  size: number;
  model: string | null;
  serial: string | null;
  transport: string;
}

export interface NodeArray {
  state: ArrayState;
  members: ArrayMember[];
  parity: Parity;
  candidates: DriveCandidate[];
  /** The mounter's reasons for a state other than healthy. */
  reasons: string[];
}

export interface SyncthingDevice {
  deviceId: string;
  addresses: string[];
  /** For a remote device the connection's type (tcp-client, relay-server, ...); null for this host's own instance. */
  connectionType: string | null;
  inRate: number;
  outRate: number;
  version: string | null;
}

export type FolderType = "sendreceive" | "sendonly" | "receiveonly" | "receiveencrypted";

/** A folder type in words, as the pages and Activity name it. */
export const folderTypeTexts: Record<FolderType, string> = {
  sendreceive: "send and receive",
  sendonly: "send only",
  receiveonly: "receive only",
  receiveencrypted: "receive encrypted",
};

export interface FolderFile {
  at: string;
  filename: string;
  deleted: boolean;
}

export interface FolderPeer {
  deviceId: string;
  name: string;
}

export interface NodeFolder {
  id: string;
  label: string;
  path: string;
  type: FolderType;
  state: string;
  completion: number;
  /** Items that failed to sync; Syncthing's `pullErrors`. */
  errors: number;
  /** Files still to fetch; Syncthing's `needFiles`. */
  needItems: number;
  /** Every item still to fetch, directories and deletes included; Syncthing's `needTotalItems`. */
  needTotalItems: number;
  needBytes: number;
  globalBytes: number;
  globalFiles: number;
  globalDirectories: number;
  lastScan: string | null;
  lastFile: FolderFile | null;
  /** Items changed here that a receive-only folder will not send on. */
  localChanged: number;
  /** Conflict copies Syncthing kept in the folder; null until the folder has been searched for them, or from a dashboard that does not count them. */
  conflicts: number | null;
  /** True when the folder holds more conflict copies than `conflicts` counts, as the index keeps only so many. */
  conflictsMore?: boolean;
  sharedWith: FolderPeer[];
}

export interface SyncthingListener {
  address: string;
  error: string | null;
}

/** What a node's own Syncthing says about itself. */
export interface SyncthingInstance {
  uptime: number;
  cpuPercent: number;
  memoryBytes: number;
  listeners: SyncthingListener[];
  discoveryErrors: string[];
  inTotal: number;
  outTotal: number;
}

/**
 * "unknown" is a peer that has not accepted the folders; "notSharing" shares none with this node;
 * "unavailable" is a peer whose completion this node's Syncthing did not answer for.
 */
export type RemoteState = "valid" | "unknown" | "notSharing" | "paused" | "unavailable";

/** How a connection reaches the other device, closest first. */
export type ConnectionKind = "this-device" | "local-network" | "tailscale" | "internet" | "relay";

export interface Peer {
  deviceId: string;
  name: string;
  connected: boolean;
  paused: boolean;
  /** Shared folders only encrypted, so a share with it needs an encryption password. */
  untrusted: boolean;
  connectionType: string | null;
  /** Null while not connected. */
  connectionKind: ConnectionKind | null;
  address: string | null;
  version: string | null;
  inRate: number;
  outRate: number;
  lastSeen: string | null;
  completion: number;
  needBytes: number;
  remoteState: RemoteState;
  /** IDs of the folders shared with this peer. */
  folders: string[];
}

export interface StorageNode {
  id: string;
  name: string;
  kind: NodeKind;
  threshold: number;
  assigned: string[];
  /** Runs on this host, so its actions are offered here. */
  local: boolean;
  online: boolean;
  /** The host that runs the node, as that host names itself. */
  host: string;
  space: Space | null;
  sync: NodeSync;
  /** Folders offered to the node and not accepted, from its Syncthing's pending folders. */
  offersWaiting: number;
  array?: NodeArray;
  syncthing: SyncthingDevice | null;
  instance: SyncthingInstance | null;
  peers: Peer[];
  folders: NodeFolder[];
  /** The other host's dashboard this node was read from; null for this host's nodes and for a device no dashboard reported. */
  dashboardUrl: string | null;
}

export type WarningKind =
  | "array"
  | "smart"
  | "agent"
  | "registry"
  | "peer"
  | "folder-errors"
  | "system-error"
  | "pending-device"
  | "pending-folder"
  | "offline"
  | "full"
  | "paused"
  | "conflicts"
  | "other";

export interface Warning {
  /** Stable while the condition lasts, so the page can keep its place. */
  id: string;
  at: string;
  level: WarningLevel;
  kind: WarningKind;
  text: string;
  nodeId: string | null;
  /** Set when the warning is about one folder, which the entry then opens. */
  folderId: string | null;
}

export const activitySources = ["syncthing", "parity", "dashboard"] as const;

export type ActivitySource = (typeof activitySources)[number];

export type ActivityLevel = "info" | "warning" | "error";

/** One line of the Activity timeline: a Syncthing event, a parity job's start or end, or a write made here. */
export interface ActivityEntry {
  id: string;
  at: string;
  source: ActivitySource;
  nodeId: string | null;
  folderId: string | null;
  /** A kebab-case name such as `state-changed`, `item-failed`, `local-change`, `parity-start` or `dashboard-write`. */
  type: string;
  level: ActivityLevel;
  text: string;
  /** Set on a `local-change` or `remote-change`, read from Syncthing's `/rest/events/disk`. */
  change?: FileChange;
}

/** One file or directory a node's Syncthing saw change; `device` is the device that changed it, the node itself for a local change. */
export interface FileChange {
  path: string;
  /** As Syncthing reports it: 2.1.6 says `modified` for a new item too, and `deleted`. */
  action: string;
  /** `file`, `dir` or `symlink`. */
  item: string;
  device: string;
}

export const changeActivityTypes = ["local-change", "remote-change"] as const;

/** The `type` that stands for both `changeActivityTypes`. */
export const changesActivityType = "changes";

/** Scans and file changes, which a busy folder produces every few seconds; `routine=false` leaves them out. */
export const routineActivityTypes = ["state-changed", ...changeActivityTypes] as const;

/**
 * `GET /api/activity?after=<id>&node=&folder=&type=&source=&routine=&limit=`, newest first; `type` takes a
 * comma-separated list (`changes` for both change types), `routine=false` leaves out the `routineActivityTypes` that
 * `type` does not name, `limit` defaults to 200. `cursor` is the newest entry's ID, for the next `after`.
 */
export interface ActivityResponse {
  entries: ActivityEntry[];
  cursor: string;
}

export const logLevels = ["debug", "info", "warning", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

/** One line of a node's Syncthing log; `message` has passed the dashboard's redaction of Syncthing's texts. */
export interface LogMessage {
  when: string;
  level: LogLevel;
  message: string;
}

/** `GET /api/nodes/<nodeId>/log?since=<instant>`: what the node's Syncthing keeps of its log in memory, oldest first. */
export interface NodeLog {
  messages: LogMessage[];
}

/** One error the node's Syncthing reported, as its own page shows it in a red banner. */
export interface NodeError {
  when: string;
  message: string;
}

/** `GET /api/nodes/<nodeId>/errors`; `POST /api/nodes/<nodeId>/errors/clear` (local nodes only) clears them and answers what is left. */
export interface NodeErrors {
  errors: NodeError[];
}

/** One of Syncthing's log facilities (a package); `debug` while it logs at debug level. */
export interface DebugFacility {
  name: string;
  description: string;
  debug: boolean;
}

/** `GET /api/nodes/<nodeId>/debug`; the POST (local nodes only) takes a `DebugChange` and answers the facilities as they now stand. */
export interface DebugFacilities {
  facilities: DebugFacility[];
}

/** The facilities to turn debug logging on and off for; every one not named stays as it is. */
export interface DebugChange {
  enable: string[];
  disable: string[];
}

/** `GET /api/nodes`; `GET /api/nodes?scope=local` leaves the other hosts out, which is what hosts ask each other. */
export interface NodesResponse {
  host: HostInfo;
  nodes: StorageNode[];
  warnings: Warning[];
}

/**
 * `POST /api/arrays/<id>/<action>`, answered 202 with `{ started }` or an `ErrorResponse`.
 * rebuild and remove need the role repeated in `confirm`; rebuild and add need `device`, one of the
 * array's candidates, and add needs `confirm: "add"`; accept-smart needs `role`.
 */
export type ArrayAction = "sync" | "scrub" | "add" | "rebuild" | "remove" | "accept-smart";

export interface ArrayActionBody {
  role?: string;
  device?: string;
  confirm?: string;
  anyway?: boolean;
}

/** `GET /api/arrays/<id>/log`. */
export interface ArrayLogResponse {
  lines: string[];
}

export interface JoinNodeRequest {
  kind: "drive" | "folder";
  path: string;
  threshold: number;
}

/** `POST /api/join`, reached over the tailnet only. */
export interface JoinRequest {
  name: string;
  os: "linux" | "windows" | "macos";
  syncthingDeviceId: string;
  nodes: JoinNodeRequest[];
}

export interface JoinDevice {
  name: string;
  syncthingDeviceId: string;
  addresses: string[];
}

export interface JoinFolder {
  id: string;
  path: string;
  type: "sendreceive" | "sendonly" | "receiveonly";
}

export interface JoinResponse {
  devices: JoinDevice[];
  folders: JoinFolder[];
}

export interface ErrorResponse {
  error: string;
}

/** One node's copy of a folder. */
export interface FolderCopy extends NodeFolder {
  nodeId: string;
  nodeName: string;
  host: string;
  /** Runs on this host, so its actions are offered here. */
  local: boolean;
  paused: boolean;
}

/** A folder another device offers a node that the node has not accepted. */
export interface PendingFolderOffer {
  nodeId: string;
  nodeName: string;
  folderId: string;
  label: string;
  offeredBy: string;
  offeredByName: string;
  time: string;
  receiveEncrypted: boolean;
}

/** A device that asked to connect to a node and was neither accepted nor ignored there. */
export interface PendingDevice {
  nodeId: string;
  nodeName: string;
  deviceId: string;
  name: string;
  address: string;
  time: string;
}

/**
 * `POST /api/nodes/<nodeId>/pending/devices/<deviceId>/accept`: adds the asking device under `name`, every
 * other setting Syncthing's default. `recordInSetup` false keeps it out of the setup repo; absent, it is recorded.
 */
export interface AcceptDeviceBody {
  name: string;
  recordInSetup?: boolean;
}

/** `POST .../pending/devices/<deviceId>/ignore`: the offer that was ignored; `alreadyIgnored` when the node had it ignored already and nothing was written. */
export interface IgnoredDevice extends PendingDevice {
  alreadyIgnored: boolean;
}

/** The accepted device as the node now has it; `setup` says what became of it in the setup repo. */
export interface AcceptedDevice {
  device: DeviceSettings;
  setup: string;
}

/**
 * `GET /api/nodes/<nodeId>/pending/folders/<folderId>/defaults?offeredBy=<deviceId>`: what the accept form opens with.
 * On an array the folder is received only and kept with staggered versioning, and it is accepted only with its ID typed.
 */
export interface AcceptFolderDefaults {
  offer: PendingFolderOffer;
  /** The folder as the accept would create it: placed at `<root>/<label>`, shared with the offering device. */
  settings: FolderSettings;
  /** The node's root, inside which the path must stay. */
  root: string;
  /** Set on an array: `confirm` must be the folder ID. */
  confirmRequired: boolean;
  /** Why the default path cannot be used as it is; null when it can. */
  placementProblem: string | null;
}

/** `POST /api/nodes/<nodeId>/pending/folders/<folderId>/accept`: adds the offered folder, shared with `offeredBy`. */
export interface AcceptFolderBody {
  offeredBy: string;
  path: string;
  type: FolderType;
  versioning: Versioning;
  /** The folder ID typed; required on an array. */
  confirm?: string;
}

/** `POST .../pending/folders/<folderId>/ignore` and `/dismiss`: the device whose offer is answered. */
export interface FolderOfferAnswerBody {
  offeredBy: string;
  /** The folder ID typed; required to ignore on an array. */
  confirm?: string;
}

/** The offer that was ignored; `alreadyIgnored` when the device's offers of the folder were ignored already and nothing was written. */
export interface IgnoredFolderOffer extends PendingFolderOffer {
  alreadyIgnored: boolean;
}

/** A device admitted through the join API; `setup` says what became of it in the setup repo. */
export interface JoinEntry {
  name: string;
  joinedAt: string;
  setup: string;
}

/**
 * `GET /api/requests`; `?scope=local` leaves the other hosts out. `unreadable` names a node or host whose
 * requests could not be read; `notConnected` marks a node that is merely not attached, which is no fault.
 */
export interface RequestsResponse {
  devices: PendingDevice[];
  folders: PendingFolderOffer[];
  joins: JoinEntry[];
  unreadable: { name: string; reason: string; notConnected?: boolean }[];
}

/** A node's Syncthing options in our names; `deviceName` is the node's own device entry, not an option. Rates are KiB/s, 0 unlimited. */
export interface InstanceOptions {
  deviceName: string;
  listenAddresses: string[];
  globalAnnounceEnabled: boolean;
  localAnnounceEnabled: boolean;
  globalAnnounceServers: string[];
  relaysEnabled: boolean;
  natEnabled: boolean;
  maxSendKbps: number;
  maxRecvKbps: number;
  limitBandwidthInLan: boolean;
  minHomeDiskFree: { value: number; unit: string };
  /** Syncthing's usage reporting: -1 declined, 0 not asked yet, otherwise the accepted version. */
  urAccepted: number;
  crashReportingEnabled: boolean;
  reconnectionIntervalS: number;
  alwaysLocalNets: string[];
}

/** A node's Syncthing GUI, which the stack sets up; never its password or API key. */
export interface InstanceGui {
  address: string;
  useTLS: boolean;
  authMode: string;
  user: string;
  managedBy: "stack";
}

/** `GET /api/nodes/<nodeId>/options`; `keeper` rewrites some of these settings at each start, which the forms show read only. */
export interface NodeOptionsResponse {
  options: InstanceOptions;
  gui: InstanceGui;
  keeper: SettingsKeeper | null;
}

/** The options of Syncthing's own Connections settings, the ones the options form changes. */
export const connectionOptionKeys = [
  "listenAddresses",
  "maxRecvKbps",
  "maxSendKbps",
  "limitBandwidthInLan",
  "natEnabled",
  "localAnnounceEnabled",
  "globalAnnounceEnabled",
  "globalAnnounceServers",
  "relaysEnabled",
] as const;

export type ConnectionOptionKey = (typeof connectionOptionKeys)[number];
export type ConnectionOptions = Pick<InstanceOptions, ConnectionOptionKey>;
/** `PATCH /api/nodes/<nodeId>/options`, with `?applyTo=host` for every node of this host: only the options the person changed. */
export type ConnectionOptionsChange = Partial<ConnectionOptions>;

export function connectionOptionsOf(options: InstanceOptions): ConnectionOptions {
  return Object.fromEntries(connectionOptionKeys.map((key) => [key, structuredClone(options[key])])) as ConnectionOptions;
}

/** What an options edit did on one node: `unchanged` when every option already had its value, so nothing was sent. */
export type OptionsEditOutcome = "saved" | "unchanged" | "maybe saved" | "failed" | "not connected" | "skipped";

export interface NodeOptionsEdit {
  nodeId: string;
  name: string;
  outcome: OptionsEditOutcome;
  /** Why the node was not changed, or may not have been; null when it was. */
  problem: string | null;
  /** The node's options as they now stand, null when they could not be read. */
  options: InstanceOptions | null;
}

/** The answer of an options edit: the node in the path first, then each other node of the host it was applied to. */
export interface OptionsEditResponse {
  nodes: NodeOptionsEdit[];
}

/** The person's answer to Syncthing's usage reporting question; it is never answered for them. */
export type UsageReportingChoice = "accepted" | "declined";

/**
 * `PATCH /api/nodes/<nodeId>/general`: only the general settings the person changed. `deviceName` is the node's own device
 * entry, the name other devices see; the rest are options. Answered with the node's `NodeOptionsResponse` as it now stands.
 */
export interface GeneralSettingsChange {
  deviceName?: string;
  minHomeDiskFree?: { value: number; unit: DiskFreeUnit };
  usageReporting?: UsageReportingChoice;
  crashReportingEnabled?: boolean;
}

/**
 * The answer of a general settings edit: the node's options as they now stand (null when they could not be read again), and
 * `problem` when the rename was saved but the other settings were not.
 */
export interface GeneralEditResponse {
  settings: NodeOptionsResponse | null;
  problem: string | null;
}

/** The Syncthing objects the advanced editor shows whole: a node's options, one of its folders or one of its devices. */
export type AdvancedTarget = { kind: "options" } | { kind: "folder"; id: string } | { kind: "device"; id: string };

/**
 * `GET /api/nodes/<nodeId>/advanced/options|folders/<id>|devices/<id>`: the object as Syncthing has it, without any API key or password.
 * Its `PATCH` takes only the keys the person changed and answers the same.
 */
export interface AdvancedConfig {
  config: Record<string, unknown>;
  /** Whether the node's Syncthing needs a restart before a saved change takes effect. */
  restartRequired: boolean;
}

/** `GET /api/nodes/<nodeId>/restart-required`. */
export interface NodeRestartState {
  restartRequired: boolean;
  /** Whether a restart needs the node's name typed, as for an array or the host's own native Syncthing. */
  confirmRequired: boolean;
}

/** `POST /api/nodes/<nodeId>/restart`: `confirm` is the node's name, needed where `NodeRestartState.confirmRequired`. */
export interface RestartBody {
  confirm?: string;
}

export interface RestartAnswer {
  restarting: true;
}

/** The folder settings a node's new folders start with, as Syncthing's Default Folder holds them; path, label and sharing are each folder's own. */
export const folderDefaultKeys = ["type", "rescanIntervalS", "fsWatcherEnabled", "fsWatcherDelayS", "ignorePerms", "order", "minDiskFree", "maxConflicts", "syncOwnership", "syncXattrs", "versioning"] as const;
export type FolderDefaultKey = (typeof folderDefaultKeys)[number];
/** `GET /api/nodes/<nodeId>/defaults/folder`; `PATCH` takes `Partial` of it, only the fields the person changed. */
export type FolderDefaults = Pick<FolderSettings, FolderDefaultKey>;

/** The device settings a node's new devices start with, as Syncthing's Default Device holds them; the name is each device's own. */
export const deviceDefaultKeys = ["addresses", "compression", "introducer", "autoAcceptFolders", "untrusted", "allowedNetworks", "maxSendKbps", "maxRecvKbps", "numConnections"] as const;
export type DeviceDefaultKey = (typeof deviceDefaultKeys)[number];
/** `GET /api/nodes/<nodeId>/defaults/device`; `PATCH` takes `Partial` of it, only the fields the person changed. */
export type DeviceDefaults = Pick<DeviceSettings, DeviceDefaultKey>;

/** `GET` and `PUT /api/nodes/<nodeId>/defaults/ignores`: the ignore patterns a new folder starts with. */
export interface DefaultIgnores {
  lines: string[];
}

/** A device the node ignores: it is not offered as a request again until un-ignored. */
export interface IgnoredDeviceEntry {
  deviceId: string;
  name: string;
  address: string;
  time: string;
}

/** A folder the node ignores when `offeredBy` offers it. */
export interface IgnoredFolderEntry {
  folderId: string;
  label: string;
  offeredBy: string;
  offeredByName: string;
  time: string;
}

/**
 * `GET /api/nodes/<nodeId>/ignored`, and the answer of `DELETE .../ignored/devices/<deviceId>` and
 * `DELETE .../ignored/folders/<folderId>?offeredBy=<deviceId>`, which un-ignore one entry and keep every other.
 */
export interface IgnoredLists {
  devices: IgnoredDeviceEntry[];
  folders: IgnoredFolderEntry[];
}

export type DeviceCompression = "metadata" | "always" | "never";

/** `GET /api/nodes/<nodeId>/devices/<deviceId>`: one device as that node's Syncthing has it configured. */
export interface DeviceSettings {
  deviceId: string;
  name: string;
  /** `dynamic`, or `tcp://`, `quic://` and `relay://` addresses. */
  addresses: string[];
  compression: DeviceCompression;
  introducer: boolean;
  autoAcceptFolders: boolean;
  paused: boolean;
  untrusted: boolean;
  allowedNetworks: string[];
  /** 0 is unlimited. */
  maxSendKbps: number;
  maxRecvKbps: number;
  /** 0 lets Syncthing choose. */
  numConnections: number;
}

/** `PATCH /api/nodes/<nodeId>/devices/<deviceId>`: only the fields the person changed. */
export type DeviceSettingsChange = Partial<Omit<DeviceSettings, "deviceId">>;

/**
 * `POST /api/nodes/<nodeId>/devices`: the new device's ID and only the settings that differ from the
 * node's Syncthing defaults (`GET /api/nodes/<nodeId>/device-defaults`), which fill the rest.
 */
export interface NewDevice extends DeviceSettingsChange {
  deviceId: string;
  /** The node's folders to share with the device; none by default. */
  shareFolders?: string[];
}

/** The answer to `POST /api/nodes/<nodeId>/devices`: the device as now configured and which folders were shared with it. */
export interface AddedDevice {
  device: DeviceSettings;
  shared: string[];
  /** A folder whose share failed after the device was added, with why. */
  notShared: { folderId: string; problem: string }[];
}

/**
 * `DELETE /api/nodes/<nodeId>/devices/<deviceId>`: the device's name as the dashboard shows it, typed to confirm.
 * The answer is the device as it was configured. The node's own device cannot be removed (409).
 */
export interface RemoveDeviceBody {
  confirm: string;
}

/** `GET /api/nodes/<nodeId>/nearby`: a device the node's Syncthing found by discovery and has not configured. */
export interface NearbyDevice {
  deviceId: string;
  addresses: string[];
}

/** `GET /api/nodes/<nodeId>/device-id-check?id=`: the ID as Syncthing reads it, or why it cannot be added to the node. */
export interface DeviceIdCheck {
  /** Null when Syncthing does not read it as a device ID. */
  deviceId: string | null;
  problem: string | null;
}

/** A priority band of the layout: priorities from `from` up to the next band belong to `name`. */
export interface PriorityBand {
  name: string;
  from: number;
}

/** `GET /api/settings`: this host's identity and the settings config.env gives its dashboard. */
export interface HostSettings {
  name: string;
  /** Null until `up` has joined the tailnet and written the name. */
  tailnetName: string | null;
  peerDashboards: string[];
  /** Whether a topic is set, never the topic: anyone who knows it can read the notifications. */
  ntfy: { url: string; topicSet: boolean };
  /** The layout's bands, highest first; null while the setup repo's layout defines none. */
  priorityBands: PriorityBand[] | null;
  setupRepo: boolean;
}

export const topDirectoryDefault = 0;

/**
 * One directory's priority in the tree, where the top directory is 0 unless the layout sets `.`.
 * `inheritedFrom` is the layout path of the ancestor that set `inherited` (`.` for the top
 * directory's entry), null when it is the top directory's default.
 */
export interface PriorityInfo {
  effective: number;
  setHere: number | null;
  inherited: number;
  inheritedFrom: string | null;
  source: "setup-repo" | "inherited" | "default";
  overridesParent: boolean;
}

/**
 * A directory's or file's state on one node, the explorer's colours: "failed" red, "syncing" orange,
 * "missing" grey (not on that node yet), "unknown" while the node's Syncthing does not answer.
 */
export type EntryStatus = "failed" | "syncing" | "missing" | "ignored" | "local-only" | "below-threshold" | "paused" | "unknown" | "in-sync";

/** `detail` says why, e.g. `3 items outstanding below`, `offered, not accepted`. */
export interface NodeEntryState {
  nodeId: string;
  nodeName: string;
  host: string;
  status: EntryStatus;
  detail: string | null;
}

/**
 * One row of the explorer. `path` is relative to the tree root with `/` separators; `folder` is set
 * on a Syncthing folder's root row; `availability` lists the devices that hold the entry.
 */
export interface TreeEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modified: string | null;
  folder: { id: string; label: string } | null;
  priority: PriorityInfo;
  nodes: NodeEntryState[];
  availability: { deviceId: string; name: string }[];
}

/** `GET /api/tree?node=<nodeId>&path=<relative path>&page=<n>`: one page of a directory, pages counted from 1. */
export interface TreeListing {
  path: string;
  view: string;
  priority: PriorityInfo;
  overridesBelow: { path: string; priority: number; parent: number }[];
  entries: TreeEntry[];
  nextPage: number | null;
  notes: string[];
}

/** Every copy of one Syncthing folder ID across the nodes, and the offers of it nobody accepted yet. */
export interface FolderSummary {
  id: string;
  label: string;
  /** From the setup repo's layout; null while the layered sync has not set one. */
  priority: number | null;
  prioritySource: "setup-repo" | "none";
  copies: FolderCopy[];
  offers: PendingFolderOffer[];
}

/** `GET /api/folders`; `?scope=local` leaves the other hosts out, which is what hosts ask each other. */
export interface FoldersResponse {
  folders: FolderSummary[];
  /** Nodes whose Syncthing answered but refused their folder list, with the reason; their folders are not listed. */
  unreadable: { nodeId: string; nodeName: string; error: string }[];
  /** Nodes whose Syncthing answered but whose pending offers could not be read, with the reason. */
  offersUnreadable: { nodeId: string; nodeName: string; error: string }[];
}

/** A folder's file versioning in Syncthing's own shape: `params` are strings, `fsPath` is the versions path, empty for `.stversions` inside the folder. */
export interface Versioning {
  type: "" | "trashcan" | "simple" | "staggered" | "external";
  params: Record<string, string>;
  cleanupIntervalS: number;
  fsPath: string;
}

export type VersioningType = Versioning["type"];

/** A node's Syncthing settings for one folder. */
export interface FolderSettings {
  id: string;
  label: string;
  path: string;
  type: FolderType;
  paused: boolean;
  rescanIntervalS: number;
  fsWatcherEnabled: boolean;
  fsWatcherDelayS: number;
  ignorePerms: boolean;
  order: "random" | "alphabetic" | "smallestFirst" | "largestFirst" | "oldestFirst" | "newestFirst";
  minDiskFree: { value: number; unit: "%" | "kB" | "MB" | "GB" | "TB" };
  maxConflicts: number;
  syncOwnership: boolean;
  syncXattrs: boolean;
  /** `encrypted`: the device gets this folder encrypted; the password itself never leaves Syncthing. */
  devices: { deviceId: string; encrypted: boolean }[];
  versioning: Versioning;
}

export type PullOrder = FolderSettings["order"];

/** A pull order in words, as the form offers it and Activity names it. */
export const pullOrderTexts: Record<PullOrder, string> = {
  random: "random",
  alphabetic: "alphabetic",
  smallestFirst: "smallest first",
  largestFirst: "largest first",
  oldestFirst: "oldest first",
  newestFirst: "newest first",
};

export type DiskFreeUnit = FolderSettings["minDiskFree"]["unit"];

export const diskFreeUnits: readonly DiskFreeUnit[] = ["%", "kB", "MB", "GB", "TB"];

/** The folder types a folder can be given here; receive encrypted is only ever accepted from an offer. */
export const editableFolderTypes: readonly FolderType[] = ["sendreceive", "sendonly", "receiveonly"];

/** A device to share a folder with. `encryptionPassword` makes it receive the folder encrypted; an untrusted device needs one. */
export interface FolderShare {
  deviceId: string;
  encryptionPassword?: string;
}

/** A share's encryption password as it is sent, trimmed; a blank one is no password, so whitespace is never sent as one. */
export function sharePassword(password: string | undefined): string | null {
  const trimmed = password?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** A share of a folder with `deviceId`, carrying the password only when there is one. */
export function folderShare(deviceId: string, password: string | undefined): FolderShare {
  const kept = sharePassword(password);
  return kept === null ? { deviceId } : { deviceId, encryptionPassword: kept };
}

/**
 * The `devices` field of a folder edit: the devices to start and to stop sharing the folder with. Every other device
 * keeps its share as it is, and a device already shared (or already not shared) changes nothing. Sharing an already
 * shared device with another password is refused: a password changes only by stopping sharing and sharing again.
 */
export interface FolderSharingChange {
  share?: FolderShare[];
  unshare?: string[];
}

/**
 * `PATCH /api/nodes/<nodeId>/folders/<folderId>`: only the settings the form changed; the folder ID cannot change.
 * `versioning` goes whole, with exactly its type's params: Syncthing resets a cleanup interval left out of it.
 */
export type FolderSettingsChange = Partial<
  Pick<FolderSettings, "label" | "path" | "type" | "rescanIntervalS" | "fsWatcherEnabled" | "fsWatcherDelayS" | "ignorePerms" | "order" | "minDiskFree" | "maxConflicts" | "syncOwnership" | "syncXattrs" | "versioning">
> & { devices?: FolderSharingChange };

/** The body of a folder edit: the change, and on an array the folder ID typed (`confirm`) when it shares the folder with a device. */
export type FolderEditBody = FolderSettingsChange & { confirm?: string };

/** Each editable folder setting as the form labels it; a refusal names the setting the same way. */
export const folderSettingLabels: Record<keyof FolderSettingsChange, string> = {
  label: "Label",
  path: "Path",
  type: "Type",
  rescanIntervalS: "Full rescan interval",
  fsWatcherEnabled: "Watch for changes",
  fsWatcherDelayS: "Watch delay",
  ignorePerms: "Ignore permissions",
  order: "Pull order",
  minDiskFree: "Minimum free disk",
  maxConflicts: "Conflict copies kept",
  syncOwnership: "Sync ownership",
  syncXattrs: "Sync extended attributes",
  versioning: "File versioning",
  devices: "Sharing",
};

/** A refused or failed request's answer. */
export interface ErrorAnswer {
  error: string;
  /** Set when a write's answer was lost and its effect could not be read back: it may have been saved. */
  maybeSaved?: true;
}

/** `POST /api/nodes/<nodeId>/folders`: a folder to add to the node; every setting it leaves out is the node's Syncthing default. */
export interface NewFolder {
  id: string;
  label?: string;
  /** Inside the node's root and not inside another node's root on this host. */
  path: string;
  type?: FolderType;
  paused?: boolean;
  /** The folder's ignore patterns; when absent, the node's defaults. */
  ignores?: string[];
  /** The folder ID typed; required on an array (`NewFolderDefaults.confirmRequired`). */
  confirm?: string;
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/ignores`, and the answer of its `PUT`: the folder's `.stignore` on that node. */
export interface FolderIgnores {
  /** The file's lines as written. */
  lines: string[];
  /** The patterns Syncthing matches, each line expanded; those that came only from included files are left out. */
  expanded: string[];
  /** How many expanded patterns came from included files and are not shown, as an included file is not the dashboard's to show. */
  hiddenIncluded: number;
  /** Why Syncthing cannot use the patterns; while set, the folder does not sync. */
  error: string | null;
}

/** `PUT /api/nodes/<nodeId>/folders/<folderId>/ignores`: the whole new file, and the lines the form opened with. */
export interface IgnoresChange {
  lines: string[];
  /** The file as the form read it; when the node's file differs by now, nothing is written. */
  opened: string[];
}

/** `POST /api/nodes/<nodeId>/folders/<folderId>/rescan`: the whole folder, or only `sub`, a directory or file below its path. */
export interface RescanBody {
  sub?: string;
}

/** The answer of a rescan: which folder, or null for every folder of the node, and which part of it. */
export interface FolderRescan {
  folderId: string | null;
  sub: string | null;
}

/** `DELETE /api/nodes/<nodeId>/folders/<folderId>`: the folder's label or ID, typed exactly, confirms the removal. */
export interface RemoveFolderBody {
  confirm: string;
}

/** What may be typed to confirm a folder's removal: its label when it has one, or its ID. */
export function removalConfirmations(folder: { id: string; label: string }): string[] {
  return folder.label && folder.label !== folder.id ? [folder.label, folder.id] : [folder.id];
}

/** The answer of a removal: the folder is gone from the node's Syncthing, its files are still at `path`. */
export interface RemovedFolder {
  folderId: string;
  label: string;
  path: string;
  /** In words, saying that the files stay on disk. */
  text: string;
}

/** `GET /api/nodes/<nodeId>/folder-defaults?under=<tree path>`: a new folder as the node's Syncthing would make it, placed at that directory. */
export interface NewFolderDefaults {
  settings: FolderSettings;
  /** The node's default ignore patterns, which a new folder starts with. */
  ignores: string[];
  /** The node's root, inside which the path must stay. */
  root: string;
  /** Why the directory the form was opened at cannot be the folder, so the root is offered instead; null when it can. */
  placementProblem: string | null;
  /** Set on an array: `confirm` must be the folder ID. */
  confirmRequired: boolean;
}

/** `GET /api/nodes/<nodeId>/folder-path-check?path=`: how the add would judge a typed path. */
export interface FolderPathCheck {
  /** The path as it would be sent: `..` resolved, the node's separator. */
  path: string;
  /** Why the add would refuse it. */
  problem: string | null;
  /** An overlap with one of the node's folders, which Syncthing allows but syncs twice. */
  warning: string | null;
}

/** One item of a folder's index; `modifiedBy` names the device that last changed it, null when Syncthing does not say. */
export interface FolderItem {
  name: string;
  size: number;
  modified: string;
  deleted: boolean;
  modifiedBy: string | null;
}

/** Where an outstanding item stands in Syncthing's pull: being fetched, next in line, or waiting behind those. */
export type NeedStage = "progress" | "queued" | "rest";

export interface NeedItem extends FolderItem {
  stage: NeedStage;
}

/** What a page of an item list holds unless the person asks for another size, and the most it may hold: Syncthing walks the whole list for each page. */
export const defaultItemsPerPage = 50;
export const maxItemsPerPage = 100;

/** How long a node's Syncthing gets to answer an item list or the versions list; a folder with 900,000 items takes far longer than the 4 s the rest of the API gets. */
export const listTimeoutMs = 30_000;

/**
 * One page of an item list; `total` is the count of the whole list, null when it could not be read.
 * `GET /api/nodes/<nodeId>/folders/<folderId>/need?page=&perPage=` answers `ItemsPage<NeedItem>`: what the node still has to fetch.
 */
export interface ItemsPage<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number | null;
}

/** One item Syncthing could not sync, with its error text as Syncthing gives it. */
export interface FailedItem {
  path: string;
  error: string;
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/errors?page=&perPage=` answers `ItemsPage<FailedItem>`: the folder's failed items; `total` is Syncthing's count of them. */
export type FailedPage = ItemsPage<FailedItem>;

/** `GET /api/nodes/<nodeId>/folders/<folderId>/remote-need?device=&page=&perPage=`: what the device still needs of the node's folder. */
export interface RemoteNeedPage extends ItemsPage<FolderItem> {
  device: FolderPeer;
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/local-changed?page=&perPage=`: what was changed on the node itself in a receive only folder; `total` is Syncthing's count. */
export type LocalChangedPage = ItemsPage<FolderItem>;

/** A copy Syncthing kept when two devices changed one file at once, named `<original>.sync-conflict-<date>-<time>-<short device ID><extension>`. */
export interface ConflictFile {
  path: string;
  original: string;
  size: number;
  modified: string;
  /** The device whose change lost, named as the node knows it, else by the short ID in the name; null when a forwarded answer does not say. */
  device: string | null;
}

/**
 * `GET /api/nodes/<nodeId>/folders/<folderId>/conflicts?page=&perPage=`: the folder's conflict copies, listed only; keeping one is a file operation on the node.
 * `complete` is false while the folder is still being searched, so more may follow; `more` is true when the folder holds more than `total` copies.
 */
export interface ConflictsPage extends ItemsPage<ConflictFile> {
  complete: boolean;
  more: boolean;
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/discard-counts`: Syncthing's counts read now, what a revert or an override would discard; null when not given. */
export interface DiscardCounts {
  /** Items changed on the node in a receive only folder; Syncthing's `receiveOnlyTotalItems`. */
  localChanged: number | null;
  /** Items other devices changed that the node does not have; Syncthing's `needTotalItems`. */
  needTotalItems: number | null;
}

/**
 * `POST /api/nodes/<nodeId>/folders/<folderId>/revert` (receive only) and `.../override` (send only) take the folder ID typed exactly as `confirm`.
 * Revert deletes or replaces what was changed on the node; override replaces what other devices changed with the node's versions.
 */
export interface LocalChangesBody {
  confirm: string;
}

/** What a revert or override did; `items` is Syncthing's count just before it, null when it could not be read. */
export interface LocalChangesDone {
  folderId: string;
  action: "revert" | "override";
  items: number | null;
  text: string;
}

/** One kept version of a file, as Syncthing lists it: when it was replaced (`versionTime`, also its name in a restore), its own change time and size. */
export interface FileVersion {
  versionTime: string;
  modTime: string;
  size: number;
}

/** A directory of the versions tree, with how many files below it have a version within the date filter. */
export interface VersionsDirectory {
  path: string;
  files: number;
}

/**
 * `GET /api/nodes/<nodeId>/folders/<folderId>/versions?prefix=&from=&to=&page=&perPage=`: one level of the folder's versions tree below `prefix`,
 * directories first, then files with their versions newest first, only versions whose `versionTime` lies within `from` and `to` (instants, either may be absent).
 * `enabled` is false, with nothing listed, when the folder's versioning is off; `total` counts the entries of this level.
 */
export interface VersionsPage {
  enabled: boolean;
  versioning: Versioning;
  folderType: FolderType;
  prefix: string;
  directories: VersionsDirectory[];
  files: Record<string, FileVersion[]>;
  page: number;
  perPage: number;
  total: number;
  /** When the node's Syncthing listed its versions; the list is read once and shared for a minute while the tree is browsed. */
  readAt: string | null;
}

/**
 * `POST /api/nodes/<nodeId>/folders/<folderId>/versions/restore`: each path (as listed) to the `versionTime` of the version to put back.
 * The current file is replaced; on an array `confirm` is the folder ID typed.
 */
export interface RestoreVersionsBody {
  files: Record<string, string>;
  confirm?: string;
}

/** What a restore did: the paths put back, and Syncthing's error for each one it could not restore. */
export interface RestoredVersions {
  folderId: string;
  restored: string[];
  errors: Record<string, string>;
  text: string;
}

/** `GET /api/folders/<folderId>`; `settings` is keyed by node ID. */
export interface FolderDetailResponse {
  summary: FolderSummary;
  settings: Record<string, FolderSettings>;
  /** Where the folder's root lies in the explorer's tree (`Documents/GitHub`), as the explorer places it; null when no node places it. */
  treePath: string | null;
}

/**
 * One entry of the node registry, `/status/nodes/<id>.json` in the stack's status volume: a drive or
 * folder node found on this host, written by the mounter on Linux and by the host agent on Windows.
 * The dashboard lists every entry and talks to its Syncthing instance at `syncthing.url`.
 */
export interface NodeRegistryEntry {
  id: string;
  name: string;
  kind: "drive" | "folder";
  threshold: number;
  assigned: string[];
  /** Where the node's root is, as the writer of the entry sees it. */
  root: string;
  present: boolean;
  space: { size: number | null; used: number | null };
  syncthing: { url: string; apiKey: string } | null;
  /** When the writer last confirmed the entry; one older than 5 minutes is shown offline. */
  updated: string;
  /** False for an ephemeral node such as a test peer: its instance ID and drive are never written to the seen files. Absent means true. */
  remember?: boolean;
}
