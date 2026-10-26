import type { HostSettings, NodeOptionsResponse } from "../api/types.js";
import { RequestError, sendJson } from "../http.js";
import { type ResolvedInstance, callSyncthing, forwardRead, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { hostName, ntfyTopicSet, ntfyUrl, peerDashboards, setupRepoDirectory, tailnetHost } from "../settings.js";
import { categoryBands } from "../setupRepo.js";
import { instanceGui, instanceOptions, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

/**
 * A node's options and GUI, from its own Syncthing or, for another host's node, from that host's dashboard.
 * @implNote A remote answer is redacted again, as an older dashboard may not drop secrets itself.
 */
export async function nodeOptions(instance: ResolvedInstance): Promise<NodeOptionsResponse> {
  if (instance.kind === "remote") return redactConfig(await forwardRead(instance, `/api/nodes/${encodeURIComponent(instance.nodeId)}/options`)) as NodeOptionsResponse;
  return callSyncthing(instance, async (client) => {
    const [options, gui, ownId, devices] = await Promise.all([
      client.request<SyncthingObject>("GET", "/config/options"),
      client.request<SyncthingObject>("GET", "/config/gui"),
      client.myId(),
      client.devices(),
    ]);
    const deviceName = devices.find((device) => device.deviceID === ownId)?.name ?? "";
    return { options: instanceOptions(options ?? {}, deviceName), gui: instanceGui(gui ?? {}) };
  });
}

export function hostSettings(): HostSettings {
  return {
    name: hostName,
    tailnetName: tailnetHost || null,
    peerDashboards,
    ntfy: { url: ntfyUrl, topicSet: ntfyTopicSet },
    priorityBands: categoryBands(),
    setupRepo: setupRepoDirectory !== "",
  };
}

function decodedNodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid node ID`);
  }
}

export const optionsRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/settings$/, handle: async ({ response }) => sendJson(response, 200, hostSettings()) },
  {
    method: "GET",
    pattern: /^\/api\/nodes\/([^/]+)\/options$/,
    handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await nodeOptions(await resolveInstance(decodedNodeId(nodeId)))),
  },
];
