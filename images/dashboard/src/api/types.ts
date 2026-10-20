/**
 * The dashboard's HTTP contract, shared by the server (`src/`) and the page (`public/`).
 * Sizes are bytes, rates bytes per second, times ISO 8601 strings in UTC, percentages 0 to 100.
 */

/**
 * @implNote "device" is a Syncthing device seen only through a local Syncthing instance, because its
 * host runs no storage dashboard or could not be reached; it carries Syncthing's view and nothing else.
 */
export type NodeKind = "array" | "drive" | "folder" | "device";

export type SyncState = "idle" | "syncing" | "error" | "offline";

/** "frozen" is the C-24 freeze: more drives lost than parity covers, or data1 gone or read-only. */
export type ArrayHealth = "healthy" | "degraded" | "frozen";

export type ParityJobKind = "sync" | "scrub" | "rebuild" | "remove" | "fix" | "check" | "diff" | "status" | "unknown";

export interface HostInfo {
  name: string;
}

export interface NodeSpace {
  size: number | null;
  used: number | null;
}

export interface NodeSync {
  state: SyncState;
  completion: number | null;
  lastSeen: string | null;
}

export interface SmartHealth {
  passed: boolean | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  powerOnHours: number | null;
  /** Why the mounter holds the drive as failing, or null. */
  failing: string | null;
}

export interface ArrayMember {
  role: string;
  label: string;
  serial: string | null;
  size: number | null;
  asset: string | null;
  present: boolean;
  smart: SmartHealth | null;
  temperature: number | null;
  /** The mounter's word for the drive: present, dropped, missing or failing. */
  condition: "present" | "dropped" | "missing" | "failing";
  detail: string;
  used: number | null;
}

/**
 * @implNote Read from SnapRAID itself (its content lock and the wrapper's progress file), so a job
 * started by hand shows as well as one the dashboard or the schedule started.
 */
export interface ParityJob {
  kind: ParityJobKind;
  progress: number | null;
  startedAt: string | null;
}

export interface ParityState {
  job: ParityJob | null;
  lastSync: string | null;
  lastScrub: string | null;
  lastSyncResult: string | null;
  lastScrubResult: string | null;
  /** Why the last sync was refused, or null. */
  refused: string | null;
}

export interface ReplacementCandidate {
  path: string;
  size: number;
  model: string;
  serial: string;
  transport: string;
}

export interface ArrayDetail {
  state: ArrayHealth;
  members: ArrayMember[];
  parity: ParityState;
  candidates: ReplacementCandidate[];
  /** The mounter's reasons for a state other than healthy. */
  reasons: string[];
}

export interface SyncthingDevice {
  deviceId: string;
  addresses: string[];
  /** For a remote device the connection's type (tcp-client, relay-server, ...); null for this host's own instance. */
  connectionType: string | null;
  inRate: number | null;
  outRate: number | null;
  version: string | null;
}

export interface NodeFolder {
  id: string;
  path: string;
  type: "sendreceive" | "sendonly" | "receiveonly" | "receiveencrypted";
  state: string;
  completion: number | null;
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
  space: NodeSpace;
  sync: NodeSync;
  array?: ArrayDetail;
  syncthing: SyncthingDevice | null;
  folders: NodeFolder[];
}

export interface Warning {
  level: "info" | "warning" | "error";
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
 * `POST /api/arrays/<id>/sync|scrub|rebuild|remove`. Rebuild and remove need the role repeated in
 * `confirm`; rebuild needs `device`, one of the array's candidates. Answers 202 with `{ started }`.
 */
export interface ArrayActionRequest {
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
  space: NodeSpace;
  syncthing: { url: string; apiKey: string } | null;
  /** When the writer last confirmed the entry; one older than 5 minutes is shown offline. */
  updated: string;
}
