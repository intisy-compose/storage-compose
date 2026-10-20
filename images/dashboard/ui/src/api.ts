export type NodeKind = "array" | "drive" | "folder";
export type SyncState = "idle" | "syncing" | "error" | "offline";
export type ArrayState = "healthy" | "degraded" | "frozen";
export type WarningLevel = "info" | "warning" | "error";

export interface Space {
  size: number;
  used: number;
}

export interface NodeSync {
  state: SyncState;
  completion: number;
  lastSeen: string | null;
}

/** Either today's smartctl summary or a short verdict; the backend has not fixed which yet. */
export interface MemberSmart {
  passed?: boolean | null;
  state?: string;
  detail?: string;
  reallocatedSectors?: number | null;
  pendingSectors?: number | null;
  percentageUsed?: number | null;
  powerOnHours?: number | null;
}

export interface ArrayMember {
  role: string;
  label: string;
  serial: string | null;
  size: number | null;
  used?: number | null;
  asset: string | null;
  assetUrl?: string | null;
  present: boolean;
  smart: MemberSmart | string | null;
  temperature: number | null;
}

export interface ParityJob {
  kind: string;
  progress: number;
  startedAt: string;
}

export interface Parity {
  job: ParityJob | null;
  lastSync: string | null;
  lastScrub: string | null;
  refused?: string | null;
}

export interface DriveCandidate {
  path: string;
  size: number;
  model: string | null;
  serial: string | null;
  transport?: string;
}

export interface NodeArray {
  state: ArrayState;
  members: ArrayMember[];
  parity: Parity;
  candidates: DriveCandidate[];
}

export interface SyncthingDevice {
  deviceId: string;
  addresses: string[];
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
  local: boolean;
  online: boolean;
  host: string;
  space: Space | null;
  sync: NodeSync;
  array?: NodeArray;
  syncthing: SyncthingDevice | null;
  folders: NodeFolder[];
}

export interface Warning {
  level: WarningLevel;
  text: string;
  nodeId: string | null;
}

export interface NodesResponse {
  host: { name: string };
  nodes: StorageNode[];
  warnings: Warning[];
  settings?: { inventoryItemUrl?: string | null };
}

export type ArrayAction = "sync" | "scrub" | "add" | "rebuild" | "remove" | "accept-smart";

export interface ArrayActionBody {
  role?: string;
  device?: string;
  confirm?: string;
  anyway?: boolean;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Actions the single-array server already serves at `api/<action>`. */
const unscopedActions: ReadonlySet<ArrayAction> = new Set(["sync", "scrub", "rebuild", "remove"]);

export async function fetchNodes(): Promise<NodesResponse> {
  const response = await fetch("api/nodes", { cache: "no-store" });
  if (!response.ok) throw new Error(`api/nodes answered ${response.status}`);
  return (await response.json()) as NodesResponse;
}

async function postJson(path: string, body: ArrayActionBody): Promise<{ status: number; error: string | null }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return { status: response.status, error: response.ok ? null : (payload.error ?? `HTTP ${response.status}`) };
}

/** @implNote Today's server answers an unknown route with 404 "not found"; any other 404 is a real refusal. */
function isMissingRoute(result: { status: number; error: string | null }): boolean {
  return result.status === 404 && result.error === "not found";
}

export async function runArrayAction(nodeId: string, action: ArrayAction, body: ArrayActionBody): Promise<ActionResult> {
  try {
    let result = await postJson(`api/arrays/${encodeURIComponent(nodeId)}/${action}`, body);
    if (isMissingRoute(result) && unscopedActions.has(action)) result = await postJson(`api/${action}`, body);
    if (isMissingRoute(result)) return { ok: false, message: `This dashboard cannot ${action.replace("-", " ")} yet.` };
    return result.error === null ? { ok: true, message: `Started ${action.replace("-", " ")}.` } : { ok: false, message: `Refused: ${result.error}` };
  } catch {
    return { ok: false, message: "The dashboard is not answering." };
  }
}
