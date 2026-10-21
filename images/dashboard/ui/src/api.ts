export type {
  ArrayAction,
  ArrayActionBody,
  ArrayMember,
  ArrayState,
  DriveCandidate,
  FolderFile,
  FolderPeer,
  FolderType,
  MemberSmart,
  NodeArray,
  NodeFolder,
  NodeKind,
  NodesResponse,
  NodeSync,
  Parity,
  ParityJob,
  Peer,
  RemoteState,
  Space,
  StorageNode,
  SyncState,
  SyncthingDevice,
  SyncthingInstance,
  SyncthingListener,
  Warning,
  WarningLevel,
} from "../../src/api/types.js";
import type { ArrayAction, ArrayActionBody, NodesResponse } from "../../src/api/types.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

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

export async function runArrayAction(nodeId: string, action: ArrayAction, body: ArrayActionBody): Promise<ActionResult> {
  try {
    const result = await postJson(`api/arrays/${encodeURIComponent(nodeId)}/${action}`, body);
    return result.error === null ? { ok: true, message: `Started ${action.replace("-", " ")}.` } : { ok: false, message: `Refused: ${result.error}` };
  } catch {
    return { ok: false, message: "The dashboard is not answering." };
  }
}
