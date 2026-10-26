/**
 * The dashboard's HTTP contract, shared by the server (`src/`) and the page (`ui/`).
 * Sizes are bytes, rates bytes per second, times ISO 8601 strings in UTC, percentages 0 to 100.
 */

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
  needItems: number;
  needBytes: number;
  globalBytes: number;
  globalFiles: number;
  globalDirectories: number;
  lastScan: string | null;
  lastFile: FolderFile | null;
  /** Items changed here that a receive-only folder will not send on. */
  localChanged: number;
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

export type ActivitySource = "syncthing" | "parity" | "dashboard";

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
}

/** Scans and file changes, which a busy folder produces every few seconds; `routine=false` leaves them out. */
export const routineActivityTypes = ["state-changed", "local-change", "remote-change"] as const;

/**
 * `GET /api/activity?after=<id>&node=&folder=&type=&source=&routine=&limit=`, newest first; `type` takes a
 * comma-separated list, `routine=false` leaves out `routineActivityTypes`, `limit` defaults to 200.
 * `cursor` is the newest entry's ID, for the next `after`.
 */
export interface ActivityResponse {
  entries: ActivityEntry[];
  cursor: string;
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

/** `GET /api/nodes/<nodeId>/options`. */
export interface NodeOptionsResponse {
  options: InstanceOptions;
  gui: InstanceGui;
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

export interface Versioning {
  type: "" | "trashcan" | "simple" | "staggered" | "external";
  params: Record<string, string>;
  cleanupIntervalS: number;
  fsPath: string;
}

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

/** `PATCH /api/nodes/<nodeId>/folders/<folderId>`: only the settings the form changed; the folder ID cannot change. */
export type FolderSettingsChange = Partial<
  Pick<FolderSettings, "label" | "path" | "type" | "rescanIntervalS" | "fsWatcherEnabled" | "fsWatcherDelayS" | "ignorePerms" | "order" | "minDiskFree" | "maxConflicts" | "syncOwnership" | "syncXattrs">
>;

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
}

/** `GET /api/nodes/<nodeId>/folder-defaults?under=<tree path>`: a new folder as the node's Syncthing would make it, placed at that directory. */
export interface NewFolderDefaults {
  settings: FolderSettings;
  /** The node's root, inside which the path must stay. */
  root: string;
  /** Why the directory the form was opened at cannot be the folder, so the root is offered instead; null when it can. */
  placementProblem: string | null;
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

/** `GET /api/folders/<folderId>`; `settings` is keyed by node ID. */
export interface FolderDetailResponse {
  summary: FolderSummary;
  settings: Record<string, FolderSettings>;
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
