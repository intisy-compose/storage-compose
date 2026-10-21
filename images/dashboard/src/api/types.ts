/**
 * The dashboard's HTTP contract, shared by the server (`src/`) and the page (`ui/`).
 * Sizes are bytes, rates bytes per second, times ISO 8601 strings in UTC, percentages 0 to 100.
 */

export type NodeKind = "array" | "drive" | "folder";

export type SyncState = "idle" | "syncing" | "waiting" | "error" | "offline";

/** "frozen" is the C-24 freeze: more drives lost than parity covers, or data1 gone or read-only. */
export type ArrayState = "healthy" | "degraded" | "frozen";

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

/** "unknown" is a peer that has not accepted the folders; "notSharing" shares none with this node. */
export type RemoteState = "valid" | "unknown" | "notSharing" | "paused";

export interface Peer {
  deviceId: string;
  name: string;
  connected: boolean;
  paused: boolean;
  connectionType: string | null;
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
  array?: NodeArray;
  syncthing: SyncthingDevice | null;
  instance: SyncthingInstance | null;
  peers: Peer[];
  folders: NodeFolder[];
  /** The other host's dashboard this node was read from; null for this host's nodes and for a device no dashboard reported. */
  dashboardUrl: string | null;
}

export interface Warning {
  /** Stable while the condition lasts, so the page can keep its place. */
  id: string;
  at: string;
  level: WarningLevel;
  text: string;
  nodeId: string | null;
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
}
