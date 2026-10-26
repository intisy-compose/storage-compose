import type { DevicesResponse, StorageNode } from "../api/types.js";
import { type OtherHostView, deviceIndex } from "../deviceIndex.js";
import { driveSeenStore } from "../driveHistory.js";
import { sendJson } from "../http.js";
import { readDashboard } from "../instanceResolver.js";
import type { JoinRecords } from "../join.js";
import { cachedOtherHostNodes, nodesResponse, otherHostNodes } from "../nodes.js";
import type { Route } from "../routes.js";
import { deviceSeenStore } from "../seenStore.js";
import { hostName, peerDashboards } from "../settings.js";

function isDevicesResponse(answer: unknown): answer is DevicesResponse {
  const response = answer as DevicesResponse | null;
  return Array.isArray(response?.devices) && Array.isArray(response?.drives);
}

async function readOwnDevices(dashboardUrl: string): Promise<DevicesResponse | null> {
  const answer = await readDashboard(dashboardUrl, new URL(dashboardUrl).hostname, "/api/devices").catch(() => null);
  return isDevicesResponse(answer) ? answer : null;
}

/** One view per other host's dashboard: its nodes from the cache and, for the full answer, its own devices and drives. */
async function otherHostViews(reported: StorageNode[], readAnswers: boolean): Promise<OtherHostView[]> {
  const dashboards = [...new Set([...peerDashboards.map((peer) => peer.replace(/\/$/, "")), ...reported.map((node) => node.dashboardUrl!)])];
  const views = await Promise.all(
    dashboards.map(async (dashboardUrl) => {
      const nodes = reported.filter((node) => node.dashboardUrl === dashboardUrl);
      const answer = readAnswers ? await readOwnDevices(dashboardUrl) : null;
      const host = answer?.devices.find((device) => device.thisHost)?.key ?? nodes[0]?.host;
      return host ? [{ host, nodes, answer }] : [];
    }),
  );
  return views.flat();
}

/**
 * @implNote Other hosts' nodes come from the last full `/api/nodes` (rebuilt when older than a minute
 * for the full answer); only their own devices and drives are read live, and a local-scope answer reads
 * nothing from another host, so two hosts reading each other never wait on each other.
 */
export async function devicesResponse(scope: "all" | "local", records: JoinRecords): Promise<DevicesResponse> {
  const others = scope === "all" ? await otherHostNodes(records) : cachedOtherHostNodes();
  const ownNodes = (await nodesResponse("local", records)).nodes;
  const reported = others.filter((node) => node.dashboardUrl);
  return deviceIndex({
    host: hostName,
    ownNodes,
    otherHosts: await otherHostViews(reported, scope === "all"),
    syncthingOnlyNodes: others.filter((node) => !node.dashboardUrl),
    seen: await deviceSeenStore.load(),
    joins: Object.values(await records.all()),
    drives: await driveSeenStore.load(),
  });
}

export function deviceIndexRoutes(records: JoinRecords): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/devices$/,
      handle: async ({ response, url }) => sendJson(response, 200, await devicesResponse(url.searchParams.get("scope") === "local" ? "local" : "all", records)),
    },
  ];
}
