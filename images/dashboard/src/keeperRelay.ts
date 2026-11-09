import type { KeeperFileEntry, KeeperReport, KeeperState } from "./handoffPlan.js";
import { type HandoffReads, keeperSpaceState } from "./handoffFeed.js";
import { type LocalInstance, readDashboard } from "./instanceResolver.js";
import type { SetupLayout } from "./setupRepo.js";
import type { SpaceDecision, SpaceState } from "./spacePlan.js";

export const keeperRelayPath = "/api/layered/keepers";

/** A keeper's own space decision as a peer relays it: the first pass of its round, which counted no keeper. */
export interface RelayedDecision {
  state: SpaceState;
  threshold: number;
}

/** What a peer dashboard answers about one keeper of its host for one folder. */
export interface RelayedKeeper {
  nodeId: string;
  state: KeeperState;
  effectiveThreshold: number;
  /** The first pass of the keeper's last round, which is what a raise elsewhere may lean on; null while no round has decided it. */
  decision: RelayedDecision | null;
  /** How old the oldest thing this answer rests on was when it was sent, in seconds, on the peer's own clock. */
  ageSeconds: number;
  completion: number;
  files: Record<string, KeeperFileEntry>;
}

export interface KeeperRelayAnswer {
  folderId: string;
  keepers: RelayedKeeper[];
}

/** A node's decisions from its host's last layout round, and when they were made. */
export interface RoundDecision {
  first: SpaceDecision | null;
  final: SpaceDecision | null;
  at: number;
}

export interface KeeperRelaySources {
  layout: () => Promise<SetupLayout | null>;
  instances: () => Promise<LocalInstance[]>;
  reads: Pick<HandoffReads, "entry" | "completion" | "keeperState">;
  decisionOf: (nodeId: string) => RoundDecision | null;
  now: () => Date;
}

function entryOf(entry: Awaited<ReturnType<HandoffReads["entry"]>>): KeeperFileEntry | null {
  return entry && { type: entry.type, version: [...entry.version], size: entry.size, blocksHash: entry.blocksHash, deleted: entry.deleted, ignored: entry.ignored, invalid: entry.invalid };
}

async function relayedKeeper(sources: KeeperRelaySources, layout: SetupLayout, instance: LocalInstance, folderId: string, paths: readonly string[]): Promise<RelayedKeeper | null> {
  const node = layout.nodes.find((entry) => entry.id === instance.nodeId);
  if (!node) return null;
  const started = sources.now().getTime();
  try {
    const completion = await sources.reads.completion(instance, folderId);
    const files: Record<string, KeeperFileEntry> = {};
    for (const path of paths) {
      const found = entryOf(await sources.reads.entry(instance, folderId, path));
      if (found) files[path] = found;
    }
    const decision = sources.decisionOf(instance.nodeId);
    const state = keeperSpaceState(decision?.final ?? null) ?? (await sources.reads.keeperState(instance));
    const raised = decision?.final?.state === "raised" ? decision.final.threshold : node.threshold;
    const read = (sources.now().getTime() - started) / 1000;
    const decided = decision ? (sources.now().getTime() - decision.at) / 1000 : 0;
    return { nodeId: node.id, state, effectiveThreshold: raised, decision: decision?.first ? { state: decision.first.state, threshold: decision.first.threshold } : null, ageSeconds: Math.max(read, decided), completion, files };
  } catch {
    return null;
  }
}

/**
 * This host's keepers of the folder, for a peer dashboard to decide with: each reads its own Syncthing now, so the answer carries only the
 * age of those reads and of the space decision it leans on.
 * @implNote A keeper this host cannot read, or that has no such folder, is left out rather than reported stale.
 */
export async function keeperRelayAnswer(sources: KeeperRelaySources, folderId: string, paths: readonly string[]): Promise<KeeperRelayAnswer> {
  const layout = await sources.layout();
  const keepers: RelayedKeeper[] = [];
  if (layout) {
    for (const instance of await sources.instances()) {
      const keeper = await relayedKeeper(sources, layout, instance, folderId, paths);
      if (keeper) keepers.push(keeper);
    }
  }
  return { folderId, keepers };
}

/** A relayed report with the keeper's first-pass space decision, for what a raise frees. */
export type RelayedReport = KeeperReport & { decision: RelayedDecision | null };

export interface RelayQuery {
  folderId: string;
  paths: string[];
}

export type RelayedReads = (queries: RelayQuery[]) => Promise<RelayedReport[]>;

export type PeerRead = (dashboardUrl: string, path: string) => Promise<unknown>;

/** Enough for a URL through the gateway; a longer list of paths goes in several requests. */
const relayUrlLimit = 6000;

function relayPaths(queries: RelayQuery[]): string[] {
  const urls: string[] = [];
  for (const { folderId, paths } of queries) {
    const head = `${keeperRelayPath}?folder=${encodeURIComponent(folderId)}`;
    let url = head;
    for (const path of paths) {
      const param = `&path=${encodeURIComponent(path)}`;
      if (url !== head && url.length + param.length > relayUrlLimit) {
        urls.push(url);
        url = head;
      }
      url += param;
    }
    urls.push(url);
  }
  return urls;
}

const keeperStates: readonly string[] = ["ok", "degraded", "stopped", "frozen", "full"];

function isRelayedKeeper(value: unknown): value is RelayedKeeper {
  const keeper = value as RelayedKeeper | null;
  return typeof keeper === "object" && keeper !== null && typeof keeper.nodeId === "string" && keeperStates.includes(keeper.state) && Number.isFinite(keeper.effectiveThreshold)
    && Number.isFinite(keeper.ageSeconds) && keeper.ageSeconds >= 0 && Number.isFinite(keeper.completion) && typeof keeper.files === "object" && keeper.files !== null;
}

function worse(left: KeeperState, right: KeeperState): KeeperState {
  return left === "ok" ? right : left;
}

function merged(reports: Map<string, RelayedReport>, keeper: RelayedKeeper, folderId: string, askedAt: string): void {
  const before = reports.get(keeper.nodeId);
  const folder = { completion: keeper.completion, files: { ...(before?.folders[folderId]?.files ?? {}), ...keeper.files } };
  reports.set(keeper.nodeId, {
    nodeId: keeper.nodeId,
    online: true,
    state: before ? worse(before.state, keeper.state) : keeper.state,
    observedAt: askedAt,
    ageSeconds: Math.max(before?.ageSeconds ?? 0, keeper.ageSeconds),
    effectiveThreshold: Math.max(before?.effectiveThreshold ?? 0, keeper.effectiveThreshold),
    folders: { ...(before?.folders ?? {}), [folderId]: folder },
    decision: keeper.decision ?? before?.decision ?? null,
  });
}

/** One peer's keepers, each answered for every query; a peer that does not answer, or answers something else, reports no one. */
async function readPeer(peer: string, queries: RelayQuery[], read: PeerRead, now: () => Date): Promise<RelayedReport[]> {
  const askedAt = now().toISOString();
  const reports = new Map<string, RelayedReport>();
  for (const path of relayPaths(queries)) {
    try {
      const answer = (await read(peer, path)) as KeeperRelayAnswer | null;
      if (!answer || !Array.isArray(answer.keepers) || typeof answer.folderId !== "string") continue;
      for (const keeper of answer.keepers.filter(isRelayedKeeper)) merged(reports, keeper, answer.folderId, askedAt);
    } catch {
      return [];
    }
  }
  return [...reports.values()];
}

function defaultPeerRead(url: string, path: string): Promise<unknown> {
  return readDashboard(url, new URL(url).host, path);
}

/** The keepers of the queried folders on every peer dashboard; a node two peers report is dropped by the decision's own rule. */
export async function relayedKeepers(peers: readonly string[], queries: RelayQuery[], read: PeerRead = defaultPeerRead, now: () => Date = () => new Date()): Promise<RelayedReport[]> {
  if (peers.length === 0 || queries.length === 0) return [];
  return (await Promise.all(peers.map((peer) => readPeer(peer, queries, read, now)))).flat();
}
