import type { FolderDetailResponse, FoldersResponse } from "../api/types.js";
import { type FolderIndexSources, folderDetail, foldersResponse } from "../folderIndex.js";
import { sendJson } from "../http.js";
import { localInstances, readDashboard } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { hostName, peerDashboards } from "../settings.js";
import { readLayout } from "../setupRepo.js";
import { decodedSegment } from "./devices.js";

async function fromEveryPeer(dashboards: string[], path: string): Promise<unknown[]> {
  const answers = await Promise.allSettled(dashboards.map((dashboardUrl) => readDashboard(dashboardUrl, new URL(dashboardUrl).hostname, path)));
  return answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value] : []));
}

function isFoldersResponse(answer: unknown): answer is FoldersResponse {
  return Array.isArray((answer as FoldersResponse | null)?.folders);
}

function isFolderDetail(answer: unknown): answer is FolderDetailResponse {
  const detail = answer as FolderDetailResponse | null;
  return Array.isArray(detail?.summary?.copies) && typeof detail?.settings === "object" && detail.settings !== null;
}

export type PeerFolderReads = Pick<FolderIndexSources, "peerFolders" | "peerFolderDetails">;

/** @implNote A peer that cannot be reached, answers something other than its folders, or does not have the folder, adds nothing; the Nodes page warns about an unreachable one. */
export function peerFolderReads(dashboards: string[]): PeerFolderReads {
  return {
    peerFolders: async () => (await fromEveryPeer(dashboards, "/api/folders")).filter(isFoldersResponse).flatMap((answer) => answer.folders),
    peerFolderDetails: async (folderId) => (await fromEveryPeer(dashboards, `/api/folders/${encodeURIComponent(folderId)}`)).filter(isFolderDetail),
  };
}

const liveSources: FolderIndexSources = {
  localInstances: async () => (await localInstances()).map((instance) => ({ nodeId: instance.nodeId, nodeName: instance.name, host: hostName, client: instance.client, root: instance.root, os: instance.os })),
  ...peerFolderReads(peerDashboards),
  layout: readLayout,
};

function scopeOf(url: URL): "all" | "local" {
  return url.searchParams.get("scope") === "local" ? "local" : "all";
}

export function folderRoutesFrom(sources: FolderIndexSources): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/folders$/,
      handle: async ({ response, url }) => sendJson(response, 200, await foldersResponse(scopeOf(url), sources)),
    },
    {
      method: "GET",
      pattern: /^\/api\/folders\/([^/]+)$/,
      handle: async ({ response, url, params: [folderId] }) => sendJson(response, 200, await folderDetail(decodedSegment(folderId, "folder ID"), scopeOf(url), sources)),
    },
  ];
}

export const folderRoutes = folderRoutesFrom(liveSources);
