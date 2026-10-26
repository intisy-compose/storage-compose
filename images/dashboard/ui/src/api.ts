export type {
  ActivityEntry,
  ActivityLevel,
  ActivityResponse,
  ActivitySource,
  ArrayAction,
  ArrayActionBody,
  ArrayMember,
  ArrayState,
  ConnectionKind,
  DriveCandidate,
  EntryStatus,
  FolderCopy,
  FolderDetailResponse,
  FolderFile,
  FolderPeer,
  FolderSettings,
  FolderSummary,
  FoldersResponse,
  FolderType,
  MemberSmart,
  NodeArray,
  NodeEntryState,
  NodeFolder,
  NodeKind,
  NodesResponse,
  NodeSync,
  Parity,
  ParityJob,
  PendingFolderOffer,
  PriorityInfo,
  Peer,
  RemoteState,
  Space,
  StorageNode,
  SyncState,
  SyncthingDevice,
  SyncthingInstance,
  SyncthingListener,
  TreeEntry,
  TreeListing,
  Versioning,
  Warning,
  WarningKind,
  WarningLevel,
} from "../../src/api/types.js";
import type { ActivityResponse, ArrayAction, ArrayActionBody, FolderDetailResponse, NodesResponse, TreeListing } from "../../src/api/types.js";

export { topDirectoryDefault } from "../../src/api/types.js";

export { addressLabel, connectionKindLabel, isReachable, reachTone } from "../../src/api/deviceText.js";
export { type StatusPresentation, type StatusTone, priorityBadgeText, statusPresentation } from "../../src/api/explorerText.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchNodes(): Promise<NodesResponse> {
  return getJson("api/nodes");
}

export function fetchFolderDetail(folderId: string): Promise<FolderDetailResponse> {
  return getJson(`api/folders/${encodeURIComponent(folderId)}`);
}

export function fetchTree(node: string, path: string, page: number): Promise<TreeListing> {
  const query = new URLSearchParams({ node, path, page: String(page) });
  return getJson(`api/tree?${query.toString()}`);
}

export { routineActivityTypes } from "../../src/api/types.js";

export interface ActivityFilters {
  node: string;
  folder: string;
  source: string;
  /** Scans and file changes are shown only when this is on. */
  routine: boolean;
}

export function fetchActivity(filters: ActivityFilters, limit: number): Promise<ActivityResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const name of ["node", "folder", "source"] as const) if (filters[name]) query.set(name, filters[name]);
  if (!filters.routine) query.set("routine", "false");
  return getJson(`api/activity?${query.toString()}`);
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

export async function runArrayAction(nodeId: string, action: ArrayAction, body: ArrayActionBody): Promise<ActionResult> {
  try {
    const result = await postJson(`api/arrays/${encodeURIComponent(nodeId)}/${action}`, body);
    return result.error === null ? { ok: true, message: `Started ${action.replace("-", " ")}.` } : { ok: false, message: `Refused: ${result.error}` };
  } catch {
    return { ok: false, message: "The dashboard is not answering." };
  }
}
