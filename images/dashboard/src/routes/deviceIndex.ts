import type { DevicesResponse, DriveRecord, StorageNode } from "../api/types.js";
import { type OtherHostView, deviceIndex } from "../deviceIndex.js";
import { driveSeenStore } from "../driveHistory.js";
import { sendJson } from "../http.js";
import { readDashboard } from "../instanceResolver.js";
import type { JoinRecords, JoinedDevice } from "../join.js";
import { cachedOtherHostNodes, otherHostNodes, sharedLocalNodes } from "../nodes.js";
import type { Route } from "../routes.js";
import { type DeviceSeen, deviceSeenStore } from "../seenStore.js";
import { hostName, peerDashboards } from "../settings.js";

function isDevicesResponse(answer: unknown): answer is DevicesResponse {
  const response = answer as DevicesResponse | null;
  return Array.isArray(response?.devices) && Array.isArray(response?.drives);
}

/**
 * Each other host's own `/api/devices?scope=local`, kept for a few seconds.
 * @implNote The page polls every 5 s; without this every poll would make each peer build its local
 * nodes once more on top of the `/api/nodes` poll. A peer that did not answer is kept as null for the
 * same time, so a dead one is not dialled on every poll either.
 */
export class PeerDevicesCache {
  private readonly answers = new Map<string, { at: number; answer: DevicesResponse | null }>();

  constructor(
    private readonly maxAgeMs: number,
    private readonly timeoutMs = 5000,
  ) {}

  async read(dashboardUrl: string, now = Date.now()): Promise<DevicesResponse | null> {
    const kept = this.answers.get(dashboardUrl);
    if (kept && now - kept.at < this.maxAgeMs) return kept.answer;
    const answer = await readDashboard(dashboardUrl, new URL(dashboardUrl).hostname, "/api/devices", this.timeoutMs).catch(() => null);
    const valid = isDevicesResponse(answer) ? answer : null;
    this.answers.set(dashboardUrl, { at: now, answer: valid });
    return valid;
  }
}

export interface DevicesRouteSources {
  host: string;
  peerDashboards: string[];
  ownNodes(scope: "all" | "local"): Promise<StorageNode[]>;
  /** Other hosts' nodes and those no dashboard reported: built when stale for the full answer, as cached for local scope. */
  otherHostNodes(scope: "all" | "local"): Promise<StorageNode[]>;
  peerAnswers: PeerDevicesCache;
  seen(): Promise<DeviceSeen[]>;
  joins(): Promise<JoinedDevice[]>;
  drives(): Promise<DriveRecord[]>;
}

/** One view per other host's dashboard: its nodes from the cache and, for the full answer, its own devices and drives. */
async function otherHostViews(reported: StorageNode[], sources: DevicesRouteSources, readAnswers: boolean): Promise<OtherHostView[]> {
  const dashboards = [...new Set([...sources.peerDashboards.map((peer) => peer.replace(/\/$/, "")), ...reported.map((node) => node.dashboardUrl!)])];
  const views = await Promise.all(
    dashboards.map(async (dashboardUrl) => {
      const nodes = reported.filter((node) => node.dashboardUrl === dashboardUrl);
      const answer = readAnswers ? await sources.peerAnswers.read(dashboardUrl) : null;
      const host = answer?.devices.find((device) => device.thisHost)?.key ?? nodes[0]?.host;
      return host ? [{ host, nodes, answer }] : [];
    }),
  );
  return views.flat();
}

/** @implNote A local-scope answer reads nothing from another host, so two hosts reading each other never wait on each other. */
export async function devicesResponse(scope: "all" | "local", sources: DevicesRouteSources): Promise<DevicesResponse> {
  const others = await sources.otherHostNodes(scope);
  const ownNodes = await sources.ownNodes(scope);
  const reported = others.filter((node) => node.dashboardUrl);
  return deviceIndex({
    host: sources.host,
    ownNodes,
    otherHosts: await otherHostViews(reported, sources, scope === "all"),
    syncthingOnlyNodes: others.filter((node) => !node.dashboardUrl),
    seen: await sources.seen(),
    joins: await sources.joins(),
    drives: await sources.drives(),
  });
}

const peerAnswerMaxAgeMs = 5_000;

function liveSources(records: JoinRecords): DevicesRouteSources {
  return {
    host: hostName,
    peerDashboards,
    ownNodes: (scope) => sharedLocalNodes(records, scope),
    otherHostNodes: async (scope) => (scope === "all" ? otherHostNodes(records) : cachedOtherHostNodes()),
    peerAnswers: new PeerDevicesCache(peerAnswerMaxAgeMs),
    seen: () => deviceSeenStore.load(),
    joins: async () => Object.values(await records.all()),
    drives: () => driveSeenStore.load(),
  };
}

export function deviceIndexRoutes(records: JoinRecords): Route[] {
  const sources = liveSources(records);
  return [
    {
      method: "GET",
      pattern: /^\/api\/devices$/,
      handle: async ({ response, url }) => sendJson(response, 200, await devicesResponse(url.searchParams.get("scope") === "local" ? "local" : "all", sources)),
    },
  ];
}
