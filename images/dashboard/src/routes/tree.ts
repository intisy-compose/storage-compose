import { RequestError, sendJson } from "../http.js";
import { type ResolverSources, defaultResolverSources, findLocalNode, requireLocal, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { explorerSettings, hostName } from "../settings.js";
import { readLayout } from "../setupRepo.js";
import { type TreeNode, type TreeSources, treeListing } from "../treeListing.js";

/** A node of this host whether or not its Syncthing answers; another host's node is refused until the all-nodes view reads it. */
export async function liveTreeNode(nodeId: string, resolver: ResolverSources = defaultResolverSources): Promise<TreeNode> {
  const local = await findLocalNode(nodeId, resolver);
  if (local) return { nodeId, name: local.name, host: hostName, root: local.root, os: local.os, threshold: local.threshold, client: local.instance?.client ?? null };
  const instance = requireLocal(await resolveInstance(nodeId, resolver));
  return { nodeId, name: instance.name, host: hostName, root: instance.root, os: instance.os, threshold: instance.threshold, client: instance.client };
}

const liveSources: TreeSources = { node: (nodeId) => liveTreeNode(nodeId), layout: readLayout, needLimit: explorerSettings.needLimit, firstListsWaitMs: 10_000 };

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
      const nodeId = url.searchParams.get("node");
      if (!nodeId) throw new RequestError(400, "name a node with ?node=");
      sendJson(response, 200, await treeListing(nodeId, url.searchParams.get("path") ?? "", pageOf(url), liveSources));
    },
  },
];
