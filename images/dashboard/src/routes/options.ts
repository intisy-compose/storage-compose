import { type SettingsKeeper, keeperManagedKeys } from "../api/keeperText.js";
import { connectionOptionLabels } from "../api/optionsText.js";
import { profileProblem } from "../api/profileText.js";
import type { ConnectionOptionKey, HostSettings, NodeOptionsResponse } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type ResolvedInstance, callSyncthing, forwardRead, requireLocal, resolveInstance, settingsKeeperOf } from "../instanceResolver.js";
import type { AnyRoute } from "../routeTypes.js";
import { hostName, ntfyTopicSet, ntfyUrl, peerDashboards, setupRepoDirectory, tailnetHost } from "../settings.js";
import { type SetupLayout, readLayout } from "../setupRepo.js";
import { instanceGui, instanceOptions, optionsChangeProblem, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

function keeperOf(value: unknown): SettingsKeeper | null {
  return typeof value === "string" && Object.hasOwn(keeperManagedKeys, value) ? (value as SettingsKeeper) : null;
}

/** Another dashboard's answer, redacted and rebuilt field by field, as an older or newer one may send more. */
function fromOtherDashboard(answer: unknown): NodeOptionsResponse {
  const redacted = asObject(redactConfig(answer));
  const options = asObject(redacted.options);
  return { options: instanceOptions(options, typeof options.deviceName === "string" ? options.deviceName : ""), gui: instanceGui(asObject(redacted.gui)), keeper: keeperOf(redacted.keeper) };
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
    return { options: instanceOptions(options ?? {}, deviceName), gui: instanceGui(gui ?? {}), keeper: settingsKeeperOf(instance) };
  });
}

/** This host's settings; the bands are the layout's own or the design's default, null without a layout. */
export function hostSettings(layout: SetupLayout | null): HostSettings {
  return {
    name: hostName,
    tailnetName: tailnetHost || null,
    peerDashboards,
    ntfy: { url: ntfyUrl, topicSet: ntfyTopicSet },
    priorityBands: layout?.bands.length ? layout.bands : null,
    priorityBandsFromLayout: layout?.bandsFromLayout ?? false,
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

function optionName(key: string): string {
  return connectionOptionLabels[key as ConnectionOptionKey] ?? key;
}

/**
 * Refuses a connection options change for one node: every connection option is the connection profile's, so a change to one is
 * made to the profile, for the whole cluster or as the node's limits override.
 */
export function refuseNodeOptions(instance: ResolvedInstance, change: unknown): never {
  requireLocal(instance);
  const keys = typeof change === "object" && change !== null ? Object.keys(change) : [];
  const problem = profileProblem(keys, optionName) ?? optionsChangeProblem(change);
  throw new RequestError(400, problem ?? "nothing to change");
}

export interface OptionsRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
}

const liveSources: OptionsRouteSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function optionsRoutes(sources: OptionsRouteSources = liveSources): AnyRoute[] {
  const optionsPattern = /^\/api\/nodes\/([^/]+)\/options$/;
  return [
    { method: "GET", pattern: /^\/api\/settings$/, handle: async ({ response }) => sendJson(response, 200, hostSettings(await layoutOrNull())) },
    {
      method: "GET",
      pattern: optionsPattern,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await nodeOptions(await sources.resolve(decodedNodeId(nodeId)))),
    },
    {
      method: "PATCH",
      pattern: optionsPattern,
      write: async ({ request, params: [nodeId] }) => refuseNodeOptions(await sources.resolve(decodedNodeId(nodeId)), await readBody(request)),
    },
  ];
}
