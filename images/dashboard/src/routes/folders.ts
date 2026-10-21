import type { FolderDetailResponse, FolderSummary, FoldersResponse } from "../api/types.js";
import { arrayIds, arrayStatus } from "../arrayStatus.js";
import { type FolderIndexSources, type FolderInstance, folderDetail, foldersResponse } from "../folderIndex.js";
import { sendJson } from "../http.js";
import { readDashboard } from "../instanceResolver.js";
import { registryEntries, syncthingEndpoint } from "../instances.js";
import type { Route } from "../routes.js";
import { hostName, peerDashboards } from "../settings.js";
import { readLayout } from "../setupRepo.js";
import { SyncthingClient } from "../syncthing.js";

async function arrayInstances(): Promise<FolderInstance[]> {
  const instances = await Promise.all(
    (await arrayIds()).map(async (id) => {
      const status = await arrayStatus(id);
      const endpoint = status?.present ? await syncthingEndpoint(id) : null;
      return status && endpoint ? [{ nodeId: id, nodeName: status.name, host: hostName, client: new SyncthingClient(endpoint) }] : [];
    }),
  );
  return instances.flat();
}

async function registryInstances(): Promise<FolderInstance[]> {
  const instances = await Promise.all(
    (await registryEntries()).map(async (entry) => {
      const endpoint = entry.present ? await syncthingEndpoint(entry.id, entry) : null;
      return endpoint ? [{ nodeId: entry.id, nodeName: entry.name, host: hostName, client: new SyncthingClient(endpoint) }] : [];
    }),
  );
  return instances.flat();
}

async function fromEveryPeer<T>(path: string): Promise<T[]> {
  const answers = await Promise.allSettled(
    peerDashboards.map((peer) => {
      const dashboardUrl = peer.replace(/\/$/, "");
      return readDashboard(dashboardUrl, new URL(dashboardUrl).hostname, path) as Promise<T>;
    }),
  );
  return answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value] : []));
}

/** @implNote A peer that cannot be reached, or does not have the folder, adds nothing; the Nodes page warns about an unreachable one. */
const liveSources: FolderIndexSources = {
  localInstances: async () => [...(await arrayInstances()), ...(await registryInstances())],
  peerFolders: async () => (await fromEveryPeer<FoldersResponse>("/api/folders")).flatMap((answer) => answer.folders as FolderSummary[]),
  peerFolderDetails: (folderId) => fromEveryPeer<FolderDetailResponse>(`/api/folders/${encodeURIComponent(folderId)}`),
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
    handle: async ({ response, url, params: [folderId] }) => sendJson(response, 200, await folderDetail(decodeURIComponent(folderId), scopeOf(url), liveSources)),
  },
];
