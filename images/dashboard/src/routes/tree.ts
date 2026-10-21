import { RequestError, sendJson } from "../http.js";
import { type LocalNodeInfo, type ResolverSources, defaultResolverSources, findLocalNode, forwardRead, localNodeInfos, readDashboard, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { cachedOtherHostNodes } from "../nodes.js";
import { explorerSettings, hostName, peerDashboards } from "../settings.js";
import { readLayout } from "../setupRepo.js";
import { type AllNodesSources, type OtherHost, allNodesListing } from "../treeAllNodes.js";
import { type TreeNode, type TreeSources, treeListing } from "../treeListing.js";

function treeNodeOf(local: LocalNodeInfo): TreeNode {
  return { nodeId: local.nodeId, name: local.name, host: hostName, root: local.root, os: local.os, threshold: local.threshold, present: local.present, client: local.instance?.client ?? null };
}

export interface TreeRequest {
  node: string;
  path: string;
  page: number;
  scope: "all" | "local";
}

export interface TreeRouteSources {
  resolver: ResolverSources;
  listing: Omit<TreeSources, "node">;
  allNodes: AllNodesSources;
}

/**
 * `node=all` lists every node's state; a node of this host is listed here, and one of another host
 * is forwarded to that host's dashboard, unless the request already came from another host.
 */
export async function treeResponse(request: TreeRequest, sources: TreeRouteSources): Promise<unknown> {
  if (request.node === "all") return allNodesListing(request.path, request.page, request.scope, sources.allNodes);
  const local = await findLocalNode(request.node, sources.resolver);
  if (local) return treeListing(request.node, request.path, request.page, { ...sources.listing, node: async () => treeNodeOf(local) });
  if (request.scope === "local") throw new RequestError(404, `no node ${request.node} on this host`);
  const instance = await resolveInstance(request.node, sources.resolver);
  if (instance.kind === "local") throw new RequestError(409, `${instance.name} is a node of this host`);
  const query = new URLSearchParams({ node: request.node, path: request.path, page: String(request.page) });
  return forwardRead(instance, `/api/tree?${query.toString()}`);
}

function otherHostOf(peer: string): OtherHost {
  const dashboardUrl = peer.replace(/\/$/, "");
  return { host: new URL(dashboardUrl).hostname, dashboardUrl };
}

const listing: Omit<TreeSources, "node"> = { layout: readLayout, needLimit: explorerSettings.needLimit, firstListsWaitMs: 10_000 };

const listingBudgetMs = 8_000;

/**
 * @implNote The all-nodes view shows a folder's counts after 3 s, a node past 4 s as still being read
 * and ends this host's part within 8 s, so one slow node never holds up the others' rows. Another
 * host spends the same 8 s on its own part, so it is waited for 3 s longer before it counts as slow.
 */
const liveSources: TreeRouteSources = {
  resolver: defaultResolverSources,
  listing,
  allNodes: {
    ...listing,
    firstListsWaitMs: 3_000,
    nodeWaitMs: 4_000,
    listingBudgetMs,
    localNodes: async () => (await localNodeInfos()).map(treeNodeOf),
    otherHosts: peerDashboards.map(otherHostOf),
    readHost: (host, path) => readDashboard(host.dashboardUrl, host.host, path, listingBudgetMs + 3_000),
    hostNodes: (host) => cachedOtherHostNodes().filter((node) => node.dashboardUrl === host.dashboardUrl).map((node) => ({ nodeId: node.id, name: node.name })),
  },
};

function pageOf(url: URL): number {
  const raw = url.searchParams.get("page");
  if (raw === null || raw === "") return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) throw new RequestError(400, `page must be 1 or more, not ${raw}`);
  return page;
}

export const treeRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/tree$/,
    handle: async ({ response, url }) => {
      const node = url.searchParams.get("node");
      if (!node) throw new RequestError(400, "name a node with ?node=, or all");
      const request: TreeRequest = { node, path: url.searchParams.get("path") ?? "", page: pageOf(url), scope: url.searchParams.get("scope") === "local" ? "local" : "all" };
      sendJson(response, 200, await treeResponse(request, liveSources));
    },
  },
];
