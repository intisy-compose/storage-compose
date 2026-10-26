import type { FolderDetailResponse, FoldersResponse } from "../api/types.js";
import { type FolderIndexSources, folderDetail, foldersResponse } from "../folderIndex.js";
import { RequestError, sendJson } from "../http.js";
import { localInstances, readDashboard } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { hostName, peerDashboards } from "../settings.js";
import { readLayout } from "../setupRepo.js";

async function fromEveryPeer(path: string): Promise<unknown[]> {
  const answers = await Promise.allSettled(
    peerDashboards.map((peer) => {
      const dashboardUrl = peer.replace(/\/$/, "");
      return readDashboard(dashboardUrl, new URL(dashboardUrl).hostname, path);
    }),
  );
  return answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value] : []));
}

function isFoldersResponse(answer: unknown): answer is FoldersResponse {
  return Array.isArray((answer as FoldersResponse | null)?.folders);
}

function isFolderDetail(answer: unknown): answer is FolderDetailResponse {
  const detail = answer as FolderDetailResponse | null;
  return Array.isArray(detail?.summary?.copies) && typeof detail?.settings === "object" && detail.settings !== null;
}

function decodedFolderId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid folder ID`);
  }
}

/** @implNote A peer that cannot be reached, or does not have the folder, adds nothing; the Nodes page warns about an unreachable one. */
const liveSources: FolderIndexSources = {
  localInstances: async () => (await localInstances()).map((instance) => ({ nodeId: instance.nodeId, nodeName: instance.name, host: hostName, client: instance.client })),
  peerFolders: async () => (await fromEveryPeer("/api/folders")).filter(isFoldersResponse).flatMap((answer) => answer.folders),
  peerFolderDetails: async (folderId) => (await fromEveryPeer(`/api/folders/${encodeURIComponent(folderId)}`)).filter(isFolderDetail),
  layout: readLayout,
};

function scopeOf(url: URL): "all" | "local" {
  return url.searchParams.get("scope") === "local" ? "local" : "all";
}

export const folderRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/folders$/,
    handle: async ({ response, url }) => sendJson(response, 200, await foldersResponse(scopeOf(url), liveSources)),
  },
  {
    method: "GET",
    pattern: /^\/api\/folders\/([^/]+)$/,
    handle: async ({ response, url, params: [folderId] }) => sendJson(response, 200, await folderDetail(decodedFolderId(folderId), scopeOf(url), liveSources)),
  },
];
