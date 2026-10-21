export type {
  ArrayAction,
  ArrayActionBody,
  ArrayMember,
  ArrayState,
  DriveCandidate,
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
  NodeFolder,
  NodeKind,
  NodesResponse,
  NodeSync,
  Parity,
  ParityJob,
  PendingFolderOffer,
  Peer,
  RemoteState,
  Space,
  StorageNode,
  SyncState,
  SyncthingDevice,
  SyncthingInstance,
  SyncthingListener,
  Versioning,
  Warning,
  WarningLevel,
} from "../../src/api/types.js";
import type { ArrayAction, ArrayActionBody, FolderDetailResponse, FoldersResponse, NodesResponse } from "../../src/api/types.js";

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

export function fetchFolders(): Promise<FoldersResponse> {
  return getJson("api/folders");
}

export function fetchFolderDetail(folderId: string): Promise<FolderDetailResponse> {
  return getJson(`api/folders/${encodeURIComponent(folderId)}`);
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
