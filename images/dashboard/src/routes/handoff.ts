import { lastRoundDecision } from "../applyLayout.js";
import { type HandoffContract, publishedContract, syncthingHandoffReads } from "../handoffFeed.js";
import { RequestError, sendJson } from "../http.js";
import { localInstances } from "../instanceResolver.js";
import { type KeeperRelaySources, keeperRelayAnswer } from "../keeperRelay.js";
import type { AnyRoute } from "../routeTypes.js";
import { readLayout } from "../setupRepo.js";

const liveKeeperSources: KeeperRelaySources = {
  layout: () => readLayout(),
  instances: () => localInstances(),
  reads: syncthingHandoffReads,
  decisionOf: lastRoundDecision,
  now: () => new Date(),
};

/**
 * The contract this host last wrote for one of its nodes, read-only, for the pages to show what is about to leave a node, and this host's
 * keepers of a folder, for a peer dashboard deciding a hand-off.
 * @implNote A joined device gets its contract only in the answer to its report on the join port, which checks that the caller owns the
 * node; this route never serves a device off this host.
 */
export function handoffRoutes(contractOf: (nodeId: string) => HandoffContract | null = publishedContract, keeperSources: KeeperRelaySources = liveKeeperSources): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/layered\/keepers$/,
      handle: async ({ response, url }) => {
        const folderId = url.searchParams.get("folder");
        if (!folderId) throw new RequestError(400, "a keeper report names its folder");
        sendJson(response, 200, await keeperRelayAnswer(keeperSources, folderId, url.searchParams.getAll("path")));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/handoff\/node\/([0-9a-f]{4})$/,
      handle: async ({ response, params: [nodeId] }) => {
        const contract = contractOf(nodeId);
        if (!contract) throw new RequestError(404, `this host has written no hand-off contract for node ${nodeId}`);
        sendJson(response, 200, contract);
      },
    },
  ];
}
