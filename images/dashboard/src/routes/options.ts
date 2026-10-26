import type { HostSettings, NodeOptionsResponse } from "../api/types.js";
import { RequestError, sendJson } from "../http.js";
import { type ResolvedInstance, callSyncthing, forwardRead, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { hostName, ntfyTopicSet, ntfyUrl, peerDashboards, setupRepoDirectory, tailnetHost } from "../settings.js";
import { type SetupLayout, readLayout } from "../setupRepo.js";
import { instanceGui, instanceOptions, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

/** Another dashboard's answer, redacted and rebuilt field by field, as an older or newer one may send more. */
function fromOtherDashboard(answer: unknown): NodeOptionsResponse {
  const redacted = asObject(redactConfig(answer));
  const options = asObject(redacted.options);
  return { options: instanceOptions(options, typeof options.deviceName === "string" ? options.deviceName : ""), gui: instanceGui(asObject(redacted.gui)) };
}

/**
 * A node's options and GUI, from its own Syncthing or, for another host's node, from that host's dashboard.
 */
export async function nodeOptions(instance: ResolvedInstance): Promise<NodeOptionsResponse> {
  if (instance.kind === "remote") return fromOtherDashboard(await forwardRead(instance, `/api/nodes/${encodeURIComponent(instance.nodeId)}/options`));
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

/** This host's settings; the bands are the layout's own, null when it has none or there is no setup repo. */
export function hostSettings(layout: SetupLayout | null): HostSettings {
  return {
    name: hostName,
    tailnetName: tailnetHost || null,
    peerDashboards,
    ntfy: { url: ntfyUrl, topicSet: ntfyTopicSet },
    priorityBands: layout?.bands.length ? layout.bands : null,
    setupRepo: setupRepoDirectory !== "",
  };
}

async function layoutOrNull(): Promise<SetupLayout | null> {
  return readLayout().catch(() => null);
}

function decodedNodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid node ID`);
  }
}

export const optionsRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/settings$/, handle: async ({ response }) => sendJson(response, 200, hostSettings(await layoutOrNull())) },
  {
    method: "GET",
    pattern: /^\/api\/nodes\/([^/]+)\/options$/,
    handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await nodeOptions(await resolveInstance(decodedNodeId(nodeId)))),
  },
];
