import { type HandoffContract, publishedContract } from "../handoffFeed.js";
import { RequestError, sendJson } from "../http.js";
import type { AnyRoute } from "../routeTypes.js";

/**
 * The contract this host last wrote for one of its nodes, read-only, for the pages to show what is about to leave a node.
 * @implNote A joined device fetches its nodes' contracts in phase 6 through the join port, which checks that the caller owns the node,
 * as `/api/connections/node/` does; this route never serves a device off this host.
 */
export function handoffRoutes(contractOf: (nodeId: string) => HandoffContract | null = publishedContract): AnyRoute[] {
  return [
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
