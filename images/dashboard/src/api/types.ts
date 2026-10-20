/**
 * The dashboard's HTTP contract, shared by the server (`src/`) and the page (`ui/`).
 * Sizes are bytes, rates bytes per second, times ISO 8601 strings in UTC, percentages 0 to 100.
 */

export type NodeKind = "array" | "drive" | "folder";

export type SyncState = "idle" | "syncing" | "error" | "offline";

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

export interface NodeSync {
  state: SyncState;
  completion: number;
  lastSeen: string | null;
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
  /** INVENTORY_ASSET_URL with the asset filled in, when both are set. */
  assetUrl: string | null;
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

export interface NodeFolder {
  id: string;
  path: string;
  type: string;
  state: string;
  completion: number;
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
  folders: NodeFolder[];
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
  settings?: { inventoryItemUrl?: string | null };
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
