import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HandoffWaitingView, LayeredChange, LayeredHandoff, LayeredSpace, LayeredState } from "./api/types.js";
import { recordDashboardActivity } from "./eventFeed.js";
import { agentHandoffFiles, agentNodeFiles } from "./agentFiles.js";
import { type HandoffContract, type HandoffPublisher, type HandoffWaiting, handoffPublisher, syncthingHandoffReads } from "./handoffFeed.js";
import { isReportFresh, keeperReportMaxAgeSeconds } from "./handoffPlan.js";
import { ReportClient } from "./joinedClient.js";
import { type RelayedReads, type RelayedReport, type RoundDecision, relayedKeepers } from "./keeperRelay.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances } from "./instanceResolver.js";
import { layeredStateOf, recordLayered } from "./layeredDrift.js";
import { type LayeredPauses, type PauseMark, fileLayeredPauses } from "./layeredPauses.js";
import { type NotifiedState, fileNotifiedState, memoryNotifiedState } from "./notifiedState.js";
import { type Notification, queueNotification } from "./notifyOutbox.js";
import { type NodePlan, handoffIgnoreFile, keepsFolder, nodePlan } from "./nodePlan.js";
import { type HandoffFiles, type NodeReconcile, carriedLayoutPaths, reconcileNode } from "./reconcileNode.js";
import { hostAgentHandoffDirectory, layeredPausesFile, nodeVolumesDirectory, peerDashboards, statusDirectory, storageRoot } from "./settings.js";
import { type LayoutNode, type SetupLayout, blockedNodeIds, readCommittedLayout, readLayout } from "./setupRepo.js";
import { followLayout, nodeFilePath, withdrawApply } from "./nodeFile.js";
import { type FolderSize, type FolderSizes, type NodeSpace, type ReleasableBytes, type SpaceDecision, effectiveThreshold, spaceAllowsPull } from "./spacePlan.js";
import type { SyncthingFolderConfig } from "./syncthing.js";

/** What a space decision reads of a node: its disk, and each planned folder's size as its own Syncthing counts it. */
/** A folder's `/rest/db/status` as far as a space decision reads it; `state` and `remoteSequence` say whether it is indexed yet. */
export type FolderStatus = FolderSize & { state?: string; stateChanged?: string; remoteSequence?: Record<string, number> | null };

export interface SpaceReads {
  space(instance: LocalInstance): Promise<NodeSpace | null>;
  sizes(instance: LocalInstance, folderId: string): Promise<FolderStatus>;
  /** A keeper's own completion of a folder; without it nothing a raise drops counts as freed. */
  completion?(instance: LocalInstance, folderId: string): Promise<number>;
}

export interface LayoutRoundDependencies {
  /** The layout as the last pull left it; null while the setup repo holds none. */
  layout: () => Promise<SetupLayout | null>;
  instances: () => Promise<LocalInstance[]>;
  handoffFiles: HandoffFiles;
  /** Writes each node's hand-off contract; a round without one writes none. */
  handoffs?: HandoffPublisher;
  /** Brings the node's own `.storage/node.toml` to its layout policy; true when it wrote. A round without one leaves node files alone. */
  nodeFiles?: NodeFiles;
  /** The layout as `HEAD` commits it, and whether that commit is on the upstream; null on any doubt. A round without one only withdraws. */
  committedLayout?: () => Promise<CommittedLayout | null>;
  /** Each node's disk and folder sizes for its space decision; a round without them decides nothing, which holds every type-up and hand-off. */
  space?: SpaceReads;
  /** The folders the layered sync paused; a round without it writes no pause or resume. */
  pauses?: LayeredPauses;
  /** Sends a notification through the mounter's outbox; a round without it sends none. */
  notify?: (notification: Notification) => Promise<void>;
  /** What was last notified, kept across restarts; a round without it keeps it in memory. */
  notified?: NotifiedState;
  /** The keepers of other hosts, read through their dashboards with an age of their own; a round without them counts only this host's keepers. */
  relayed?: RelayedReads;
  /** Enters one written change in Activity. */
  record: (nodeId: string, folderId: string | null, text: string) => void;
  readBackDelaysMs?: readonly number[];
  now?: () => Date;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function driftOf(result: NodeReconcile): LayeredChange[] {
  return result.folders.flatMap((folder) =>
    folder.changes.map((change) => ({ folderId: folder.folderId, label: folder.label, field: change.field, text: change.text, written: change.written, held: change.written ? null : (change.held ?? folder.held ?? folder.failed) })),
  );
}

function nodeOnlyText(entry: NodeReconcile["nodeOnlyIgnores"][number]): string {
  const kept = entry.lines.length ? [`kept ${entry.lines.join(" ")}`] : [];
  const replaced = entry.inBlock.length ? [`replaced in the block ${entry.inBlock.join(" ")}`] : [];
  return `${entry.label}: ${[...kept, ...replaced].join("; ")}`;
}

function emptyState(mode: LayeredState["mode"], threshold: number, checkedAt: string): LayeredState {
  return { mode, threshold, effectiveThreshold: threshold, drift: [], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: null, problems: [], failed: null, checkedAt, space: null, stopped: null, pausedByStop: [], pauseHeld: null, trashBytes: 0, handoff: null };
}

/** Each node's decisions from this host's last layout round, for the relay and for a joined device's round. */
const roundDecisions = new Map<string, RoundDecision>();

export function lastRoundDecision(nodeId: string): RoundDecision | null {
  return roundDecisions.get(nodeId) ?? null;
}

function spaceView(decision: SpaceDecision | null): LayeredSpace | null {
  return decision ? { state: decision.state, threshold: decision.threshold, neededBytes: decision.neededBytes, availableBytes: decision.availableBytes } : null;
}

/** A node of this host as the first pass of a round leaves it: planned at its committed threshold with its space decided, or why not. */
type Prepared =
  | { kind: "unlisted" }
  | { kind: "unadmitted"; node: LayoutNode; marks: Marks }
  | { kind: "blocked"; node: LayoutNode; problems: string[]; marks: Marks }
  | { kind: "failed"; node: LayoutNode; error: unknown; marks: Marks }
  | { kind: "planned"; node: LayoutNode; localFolders: Set<string>; plan: NodePlan; inputs: SpaceInputs | null; decision: SpaceDecision | null; resumeDecision: SpaceDecision | null; marks: Marks };

type Marks = Map<string, PauseMark> | "unreadable";

interface SpaceInputs {
  space: NodeSpace;
  sizes: FolderSizes;
  /** What the node's hand-off trash holds, which leaves it by itself once due. */
  trashBytes: number;
  /** Folders sized from their pause record, by ID, with when it was recorded. */
  recorded: Map<string, string>;
  /** Folders paused by a stop with no size recorded and none reported. */
  unsized: string[];
}

/** A size recorded with a pause counts for a resume only with this much of its global size on top, as the network may have grown since. */
export const recordedSizeMargin = 0.25;

/** A result older than this says nothing about the trash now: the contract's own age limit (phase 3). */
const resultMaxAgeSeconds = 300;

/** A result written further ahead of this host's clock than a contract may be (phase 3) is not one to trust either. */
const resultAheadSeconds = 60;

/**
 * Each round brings this host's nodes to their layered plans from the shared layout, or only reports how they differ, and writes each
 * node's hand-off contract, an empty one whenever the node cannot be planned, so an executor never acts on an older round's list.
 * @implNote A round never confirms for an array, so an array's changes always wait for the folder ID typed.
 */
export class LayoutRound {
  constructor(private readonly dependencies: LayoutRoundDependencies) {}

  /**
   * @implNote Whether a node applies comes from the committed, pushed layout through `nodeFileAction`, the same gate as its node file, so
   * the two never disagree; the working tree's layout still makes the plans and the report. A failed read of the instances leaves the last
   * round's states and writes nothing.
   */
  async run(): Promise<void> {
    const layout = await this.dependencies.layout();
    const states = new Map<string, LayeredState>();
    const instances = await this.dependencies.instances().catch((error) => {
      console.error(`layered sync: this host's nodes cannot be read: ${reasonOf(error)}`);
      return null;
    });
    if (!instances) return;
    const committed = await (this.dependencies.committedLayout?.() ?? Promise.resolve(null)).catch(() => null);
    if (this.dependencies.nodeFiles) await this.followNodeFiles(instances, committed);
    if (layout) {
      const gated = withCommittedApply(layout, committed);
      const prepared = new Map<string, Prepared>();
      for (const instance of instances) prepared.set(instance.nodeId, await this.prepare(gated, instance));
      const first = await this.decideAll(gated, instances, prepared);
      this.keepDecisions(prepared, first);
      const spaces = new Map([...prepared].flatMap(([nodeId, entry]) => (entry.kind === "planned" ? [[nodeId, entry.decision] as const] : [])));
      for (const instance of instances) {
        const state = await this.nodeState(gated, instance, instances, prepared.get(instance.nodeId) as Prepared, spaces);
        if (!state) continue;
        const handoff = await this.handoffView(instance, state.checkedAt);
        this.recordHandoffActivity(instance, state, handoff);
        await this.notifyFull(instance, state);
        states.set(instance.nodeId, { ...state, handoff });
      }
    }
    recordLayered(states);
  }

  /** A host decision older than a keeper report may be counts for nothing in a joined device's round: the keeper reads as offline. */
  private hasFreshDecision(nodeId: string): boolean {
    const decision = lastRoundDecision(nodeId);
    return decision !== null && (this.clock().getTime() - decision.at) / 1000 <= keeperReportMaxAgeSeconds;
  }

  private keepDecisions(prepared: ReadonlyMap<string, Prepared>, first: ReadonlyMap<string, SpaceDecision | null>): void {
    const at = this.clock().getTime();
    for (const [nodeId, entry] of prepared) if (entry.kind === "planned") roundDecisions.set(nodeId, { first: first.get(nodeId) ?? null, final: entry.decision, at });
  }

  /** What the round last reconciled for a joined device, read back by its answer. */
  private readonly joinedReconciled = new Map<string, { plan: NodePlan; decision: SpaceDecision | null; layout: SetupLayout; stopped: boolean }>();

  /**
   * One joined device's own round, run when its report arrives: the same preparation, space decision, reconciliation and contract as a node
   * of this host, its reads and writes going through the device's report, with this host's last round standing in for the local keepers'
   * decisions.
   */
  async joinedRound(instance: LocalInstance): Promise<JoinedRound> {
    this.joinedReconciled.delete(instance.nodeId);
    const [layout, committed, every] = await Promise.all([this.dependencies.layout(), (this.dependencies.committedLayout?.() ?? Promise.resolve(null)).catch(() => null), this.dependencies.instances().catch(() => [])]);
    const nodeFile = nodeFileAction(committed, instance.nodeId);
    if (!layout) {
      await this.clearHandoffs(instance, null);
      return { nodeFile, state: null, contract: this.dependencies.handoffs?.last?.(instance.nodeId)?.contract ?? null, reconcile: null };
    }
    const gated = withCommittedApply(layout, committed);
    const locals = every.filter((local) => this.hasFreshDecision(local.nodeId));
    const instances = [instance, ...locals];
    const prepared = new Map<string, Prepared>([[instance.nodeId, await this.prepare(gated, instance)]]);
    const known = new Map(locals.map((local) => [local.nodeId, lastRoundDecision(local.nodeId)?.first ?? null] as const));
    await this.decideAll(gated, instances, prepared, known);
    const finals = new Map(locals.map((local) => [local.nodeId, lastRoundDecision(local.nodeId)?.final ?? null] as const));
    const entry = prepared.get(instance.nodeId) as Prepared;
    if (entry.kind === "planned") finals.set(instance.nodeId, entry.decision);
    const state = await this.nodeState(gated, instance, instances, entry, finals);
    if (state) this.recordHandoffActivity(instance, state, await this.handoffView(instance, state.checkedAt));
    return { nodeFile, state, contract: this.dependencies.handoffs?.last?.(instance.nodeId)?.contract ?? null, reconcile: this.joinedReconciled.get(instance.nodeId) ?? null };
  }

  /** The executor run and the space state each node's last Activity entries were made for, so each is entered once. */
  private readonly reported = new Map<string, { finishedAt: string | null; space: string }>();

  /**
   * Activity for each new executor run (files handed off and released, by folder) and for each change of the node's space state
   * (a raise, a stop, back at its threshold).
   */
  private recordHandoffActivity(instance: LocalInstance, state: LayeredState, handoff: LayeredHandoff | null): void {
    const before = this.reported.get(instance.nodeId) ?? { finishedAt: null, space: `fits:${state.threshold}` };
    const result = handoff?.result ?? null;
    const space = state.space;
    const spaceKey = space ? `${space.state}:${space.threshold}` : before.space;
    if (result && result.finishedAt !== before.finishedAt && before.finishedAt !== null) {
      for (const [outcome, words] of [["moved", "handed off"], ["released", "released back into sync"]] as const) {
        const byFolder = new Map<string, number>();
        for (const entry of result.results.filter((candidate) => candidate.outcome === outcome)) byFolder.set(entry.folderId, (byFolder.get(entry.folderId) ?? 0) + 1);
        for (const [folderId, count] of byFolder) this.dependencies.record(instance.nodeId, folderId, `${instance.name}: ${words} ${count} ${count === 1 ? "file" : "files"} of ${folderId}`);
      }
    }
    if (space && spaceKey !== before.space) {
      const text =
        space.state === "raised" ? `${instance.name}: threshold raised from ${state.threshold} to ${space.threshold} for space`
        : space.state === "stopped" ? `${instance.name}: does not fit even at its top priority, nothing is handed off`
        : space.state === "full" ? `${instance.name}: the cluster does not fit with 10% free; it confirms no new hand-off until it does`
        : space.state === "fits" ? `${instance.name}: fits at its threshold ${state.threshold} again`
        : `${instance.name}: its space decision is unknown, nothing is handed off`;
      this.dependencies.record(instance.nodeId, null, text);
    }
    this.reported.set(instance.nodeId, { finishedAt: result?.finishedAt ?? before.finishedAt ?? "", space: spaceKey });
  }

  /** When this host first saw each file the contract waits with, by node, folder and path, so Attention can tell a wait of a day. */
  private readonly waitingSince = new Map<string, string>();

  private sinceOf(nodeId: string, waiting: HandoffWaiting[], checkedAt: string): HandoffWaitingView[] {
    const prefix = `${nodeId}\n`;
    const current = new Set(waiting.map((entry) => `${prefix}${entry.folderId}\n${entry.path}`));
    for (const key of [...this.waitingSince.keys()]) if (key.startsWith(prefix) && !current.has(key)) this.waitingSince.delete(key);
    return waiting.map((entry) => {
      const key = `${prefix}${entry.folderId}\n${entry.path}`;
      if (!this.waitingSince.has(key)) this.waitingSince.set(key, checkedAt);
      return { ...entry, since: this.waitingSince.get(key) as string };
    });
  }

  /** The node's last contract, its space decision and its executor's last result, for the node detail and Attention; null before any contract. */
  private async handoffView(instance: LocalInstance, checkedAt: string): Promise<LayeredHandoff | null> {
    const publisher = this.dependencies.handoffs;
    const last = publisher?.last?.(instance.nodeId);
    if (!publisher || !last) return null;
    const result = publisher.result ? await publisher.result(instance).catch(() => null) : null;
    const space = last.space ? { state: last.space.state, threshold: last.space.threshold, neededBytes: last.space.neededBytes, availableBytes: last.space.availableBytes } : null;
    return { writtenAt: last.contract.writtenAt, apply: last.contract.apply, entries: last.contract.entries.length, waiting: this.sinceOf(instance.nodeId, last.contract.waiting, checkedAt), notes: [...last.contract.notes], space, result };
  }

  /** @implNote A node that applies but is not enabled gets the trash-only contract whatever stopped the round, never an applying one. */
  private async clearHandoffs(instance: LocalInstance, node: LayoutNode | null): Promise<void> {
    const reason = node?.apply && !node.enabled ? `${node.name} is not enabled` : null;
    await this.dependencies.handoffs?.clear(instance.nodeId, instance, node?.apply ?? false, reason).catch((error) => console.error(`layered sync: no hand-off contract written for ${instance.nodeId}: ${reasonOf(error)}`));
  }

  private async publishHandoffs(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], localFolders: ReadonlySet<string>, decision: SpaceDecision | null, spaces: ReadonlyMap<string, SpaceDecision | null>): Promise<number | null> {
    const publisher = this.dependencies.handoffs;
    if (!publisher) return null;
    try {
      return await publisher.publish({ layout, nodeId: instance.nodeId, localFolders, instance, instances, decided: { decision }, keeperSpace: (nodeId) => spaces.get(nodeId) ?? null, relayed: this.dependencies.relayed });
    } catch (error) {
      console.error(`layered sync: no hand-off contract written for ${instance.nodeId}: ${reasonOf(error)}`);
      return null;
    }
  }

  /**
   * Every node file this host keeps follows the committed layout: fully, `apply = true` included, only for a node `nodeFileAction` lets act;
   * otherwise only its `apply` line is taken out, the layout unreadable or missing included.
   */
  private async followNodeFiles(instances: LocalInstance[], committed: CommittedLayout | null): Promise<void> {
    const files = this.dependencies.nodeFiles as NodeFiles;
    for (const instance of instances) {
      const action = nodeFileAction(committed, instance.nodeId);
      try {
        const wrote = action.kind === "follow" ? await files.follow(instance, action.policy) : await files.withdraw(instance);
        if (!wrote) continue;
        const text = action.kind === "follow" ? `${instance.name}: node file follows the layout, threshold ${action.policy.threshold}, apply on` : `${instance.name}: apply taken out of its node file: ${action.reason}`;
        this.dependencies.record(instance.nodeId, null, text);
      } catch (error) {
        console.error(`layered sync: ${instance.name}'s node file does not follow the layout: ${reasonOf(error)}`);
      }
    }
  }

  /**
   * What the first pass reads for the node's space: its disk, each planned folder's size, and its hand-off trash.
   * @implNote A folder only has a size once it is indexed (`isIndexed`); a folder the layered sync paused reports none, so the size recorded
   * with its pause stands in. A folder with no size makes a folder the node keeps `unknown`.
   */
  private async spaceInputs(instance: LocalInstance, plan: NodePlan, marks: ReadonlyMap<string, PauseMark>): Promise<SpaceInputs | null> {
    const reads = this.dependencies.space;
    if (!reads) return null;
    const space = await reads.space(instance).catch(() => null);
    if (!space) return null;
    const sizes: FolderSizes = {};
    const recorded = new Map<string, string>();
    const unsized: string[] = [];
    for (const folder of plan.folders) {
      const status = await reads.sizes(instance, folder.id).catch(() => null);
      const mark = marks.get(folder.id) ?? null;
      if (status && isIndexed(status, folder.devices.length > 1)) sizes[folder.id] = { globalBytes: status.globalBytes, localBytes: status.localBytes, needBytes: status.needBytes };
      else if (mark?.size) {
        sizes[folder.id] = mark.size;
        recorded.set(folder.id, mark.at);
      } else if (mark) unsized.push(folder.id);
    }
    const result = await this.dependencies.handoffs?.result?.(instance).catch(() => null);
    const age = result ? (this.clock().getTime() - Date.parse(result.finishedAt)) / 1000 : Number.NaN;
    const fresh = Number.isFinite(age) && age >= -resultAheadSeconds && age <= resultMaxAgeSeconds;
    const trashBytes = fresh && Number.isFinite(result?.trashBytes) ? Math.max(0, result?.trashBytes as number) : 0;
    return { space, sizes, trashBytes, recorded, unsized };
  }

  /**
   * Whether another node of this host on another device keeps the folder by its own decision of the first pass and its own Syncthing has
   * all of it, so what the node holds in sync there could leave it once each file is confirmed.
   * @implNote The first pass counts no keeper at all, so a keeper that only fits by dropping the folder onto this node is never counted: two
   * nodes short of space never drop a folder on each other's word, and a keeper's final decision keeps at least what its first one did.
   */
  private async keeperHolds(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], first: ReadonlyMap<string, SpaceDecision | null>, folderId: string, relayed: (folderId: string) => Promise<RelayedReport[]>): Promise<boolean> {
    const completion = this.dependencies.space?.completion;
    const own = layout.nodes.find((node) => node.id === instance.nodeId);
    if (!completion || !own) return false;
    for (const keeper of instances) {
      const node = layout.nodes.find((entry) => entry.id === keeper.nodeId);
      if (!node || node.id === own.id || node.device === own.device || !node.enabled) continue;
      if (!keepsByDecision(layout, node.id, folderId, first.get(node.id) ?? null)) continue;
      if (((await completion(keeper, folderId).catch(() => 0)) ?? 0) >= 100) return true;
    }
    const local = new Set(instances.map((keeper) => keeper.nodeId));
    return (await relayed(folderId)).some((report) => this.relayHolds(layout, own, report, local, folderId));
  }

  /** @implNote The same test as a local keeper's, on a report that must also be fresh and in a healthy state; its decision is its host's first pass, which counted no keeper. */
  private relayHolds(layout: SetupLayout, own: LayoutNode, report: RelayedReport, local: ReadonlySet<string>, folderId: string): boolean {
    const node = layout.nodes.find((entry) => entry.id === report.nodeId);
    if (!node || local.has(node.id) || node.id === own.id || node.device === own.device || !node.enabled) return false;
    if (report.state !== "ok" || !isReportFresh(report, this.clock(), keeperReportMaxAgeSeconds)) return false;
    return keepsByDecision(layout, node.id, folderId, report.decision) && (report.folders[folderId]?.completion ?? 0) >= 100;
  }

  /** One read per folder of a round, however many nodes ask: a raise looks at the same folder from every node that could drop it. */
  private relayedHoldings(): (folderId: string) => Promise<RelayedReport[]> {
    const relayed = this.dependencies.relayed;
    const known = new Map<string, Promise<RelayedReport[]>>();
    return (folderId) => {
      if (!relayed) return Promise.resolve([]);
      if (!known.has(folderId)) known.set(folderId, relayed([{ folderId, paths: [] }]).catch(() => []));
      return known.get(folderId) as Promise<RelayedReport[]>;
    };
  }

  /** Each planned node's final decision: its own space with what keepers of the first pass hold of the folders a raise would drop. */
  private async decideAll(layout: SetupLayout, instances: LocalInstance[], prepared: Map<string, Prepared>, known: ReadonlyMap<string, SpaceDecision | null> = new Map()): Promise<Map<string, SpaceDecision | null>> {
    const first = new Map<string, SpaceDecision | null>(known);
    const relayed = this.relayedHoldings();
    for (const [nodeId, entry] of prepared) {
      if (entry.kind !== "planned") continue;
      first.set(nodeId, entry.inputs ? effectiveThreshold(entry.plan, entry.inputs.sizes, entry.inputs.space, {}, entry.inputs.trashBytes) : null);
    }
    for (const instance of instances) {
      const entry = prepared.get(instance.nodeId);
      if (entry?.kind !== "planned" || !entry.inputs) continue;
      const releasable: ReleasableBytes = {};
      for (const folder of entry.plan.folders) {
        const size = entry.inputs.sizes[folder.id];
        if (!size || folder.local || folder.keptBy === "assigned") continue;
        if (await this.keeperHolds(layout, instance, instances, first, folder.id, relayed)) releasable[folder.id] = heldInSync(size);
      }
      entry.decision = effectiveThreshold(entry.plan, entry.inputs.sizes, entry.inputs.space, releasable, entry.inputs.trashBytes);
      entry.resumeDecision = entry.inputs.recorded.size ? effectiveThreshold(entry.plan, withMargin(entry.inputs.sizes, entry.inputs.recorded), entry.inputs.space, releasable, entry.inputs.trashBytes) : entry.decision;
    }
    return first;
  }

  private clock(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async marksOf(nodeId: string): Promise<Map<string, PauseMark> | "unreadable"> {
    const pauses = this.dependencies.pauses;
    if (!pauses) return new Map();
    return pauses.of(nodeId).catch(() => "unreadable" as const);
  }

  private async prepare(layout: SetupLayout, instance: LocalInstance): Promise<Prepared> {
    const node = layout.nodes.find((entry) => entry.id === instance.nodeId);
    if (!node) return { kind: "unlisted" };
    const marks = await this.marksOf(node.id);
    if (!node.admitted) return { kind: "unadmitted", node, marks };
    try {
      const configured = (await callSyncthing(instance, (client) => client.folders())) ?? [];
      const localFolders = carriedLayoutPaths(layout, node.id, new Set(configured.map((folder: SyncthingFolderConfig) => folder.id)));
      const plan = nodePlan(layout, node.id, localFolders);
      if (!plan) return { kind: "unlisted" };
      if (plan.problems.length) return { kind: "blocked", node, problems: plan.problems, marks };
      const inputs = await this.spaceInputs(instance, plan, marks instanceof Map ? marks : new Map());
      return { kind: "planned", node, localFolders, plan, inputs, decision: null, resumeDecision: null, marks };
    } catch (error) {
      return { kind: "failed", node, error, marks };
    }
  }

  /**
   * @implNote A raise plans at the decision's threshold, so the folders it drops turn send-only; any other decision plans at the committed
   * threshold, and the reconciler holds every type-up the decision does not allow. A recorded pause is resumed only on a decision that
   * lets the enabled node pull; any other keeps it.
   */
  private async nodeState(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], prepared: Prepared, spaces: ReadonlyMap<string, SpaceDecision | null>): Promise<LayeredState | null> {
    if (prepared.kind === "unlisted") {
      await this.clearHandoffs(instance, null);
      return null;
    }
    const node = prepared.node;
    const checkedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const state = { ...emptyState(node.apply ? "apply" : "report", node.threshold, checkedAt), pausedByStop: pausedIds(prepared.marks) };
    if (prepared.kind === "unadmitted") {
      await this.clearHandoffs(instance, node);
      return { ...state, problems: [`${node.name} is not admitted yet`] };
    }
    if (prepared.kind === "blocked") {
      await this.clearHandoffs(instance, node);
      return { ...state, problems: prepared.problems };
    }
    if (prepared.kind === "failed") return this.failedState(instance, node, state, prepared.error);
    const { decision, localFolders } = prepared;
    const stopped = stopReason(node, decision);
    try {
      const raised = decision?.state === "raised" ? (nodePlan(layout, node.id, localFolders, decision.threshold) ?? prepared.plan) : prepared.plan;
      const plan = stopped ? withFoldersPaused(prepared.plan) : raised;
      const result = await reconcileNode(instance, plan, {
        apply: node.apply,
        layout,
        space: decision,
        stopped,
        pauses: this.dependencies.pauses,
        resumeHeld: resumeHeldBy(node, prepared.resumeDecision, plan, resumeContext(prepared.inputs, this.clock())),
        sizes: prepared.inputs?.sizes,
        handoffFiles: this.dependencies.handoffFiles,
        onWritten: (folderId, text) => this.dependencies.record(instance.nodeId, folderId, text),
        readBackDelaysMs: this.dependencies.readBackDelaysMs ?? defaultReadBackDelaysMs,
      });
      if (instance.source === "joined") this.joinedReconciled.set(instance.nodeId, { plan, decision, layout, stopped: stopped !== null });
      const pendingHandoffs = await this.publishHandoffs(layout, instance, instances, localFolders, decision, spaces);
      const pauseHeld = stopped && node.apply ? heldPause(result) : null;
      await this.notifyPauses(instance, result, stopped, pauseHeld);
      const marks = await this.marksOf(node.id);
      return { ...state, pausedByStop: pausedIds(marks), pauseHeld, trashBytes: prepared.inputs?.trashBytes ?? 0, effectiveThreshold: plan.appliedThreshold, space: spaceView(decision), stopped, pendingHandoffs, drift: driftOf(result), missing: result.missing.map((folder) => folder.label), unplanned: result.unplanned, unknownDevices: result.unknownDevices, nodeOnlyIgnores: result.nodeOnlyIgnores.map(nodeOnlyText), failed: result.failed.length ? result.failed.join("; ") : null };
    } catch (error) {
      return this.failedState(instance, node, state, error);
    }
  }

  private notifiedState(): NotifiedState {
    this.fallbackNotified ??= memoryNotifiedState();
    return this.dependencies.notified ?? this.fallbackNotified;
  }

  private fallbackNotified: NotifiedState | null = null;

  /** One notification when the cluster turns full, and one when it has room again; an unknown decision changes neither. Kept across restarts. */
  private async notifyFull(instance: LocalInstance, state: LayeredState): Promise<void> {
    const notify = this.dependencies.notify;
    const space = state.space;
    if (!notify || !space || space.state === "unknown") return;
    const full = space.state === "full";
    const key = `full:${instance.nodeId}`;
    const before = (await this.notifiedState().get(key).catch(() => null)) === "full";
    if (full === before) return;
    await this.notifiedState().set(key, full ? "full" : null).catch(() => {});
    const notification: Notification = full
      ? { priority: 4, tags: "warning", title: `${instance.name} is short of space`, message: `The cluster needs ${space.neededBytes} bytes and has ${space.availableBytes}, under 10% free once it holds everything. It confirms no new hand-off until it fits, so those files stay on their nodes.` }
      : { priority: 3, tags: "white_check_mark", title: `${instance.name} has room again`, message: "The cluster fits with 10% free again and confirms hand-offs." };
    await notify(notification).catch((error) => console.error(`layered sync: no notification queued for ${instance.name}: ${reasonOf(error)}`));
  }

  /**
   * One notification for a round that paused the node's folders, one for a round that resumed them, and one per stop whose pause could
   * not be written (an array without its folder ID typed), each saying what was actually written.
   */
  private async notifyPauses(instance: LocalInstance, result: NodeReconcile, stopped: string | null, pauseHeld: string | null): Promise<void> {
    const notify = this.dependencies.notify;
    if (!notify) return;
    const written = result.folders.filter((folder) => folder.written.includes("paused"));
    const count = `${written.length} ${written.length === 1 ? "folder" : "folders"}`;
    const heldKey = `held-stop:${instance.nodeId}`;
    let notification: Notification | null = null;
    if (written.length) {
      notification = stopped
        ? { priority: 4, tags: "warning", title: `${instance.name} stopped`, message: `${stopped}: ${count} paused, so it pulls nothing and hands nothing off. It resumes once it fits with 10% free, or when enabled = true is committed again.` }
        : { priority: 3, tags: "white_check_mark", title: `${instance.name} resumed`, message: `${count} resumed: it syncs again and sends what it gathered while stopped.` };
    } else if (pauseHeld && (await this.notifiedState().get(heldKey).catch(() => null)) !== stopped) {
      await this.notifiedState().set(heldKey, stopped).catch(() => {});
      notification = { priority: 4, tags: "warning", title: `${instance.name} cannot be paused`, message: `${stopped}, but ${pauseHeld}: nothing was paused, and it hands nothing off.` };
    }
    if (!stopped) await this.notifiedState().set(heldKey, null).catch(() => {});
    if (notification) await notify(notification).catch((error) => console.error(`layered sync: no notification queued for ${instance.name}: ${reasonOf(error)}`));
  }

  private async failedState(instance: LocalInstance, node: LayoutNode, state: LayeredState, error: unknown): Promise<LayeredState> {
    await this.clearHandoffs(instance, node);
    const last = layeredStateOf(instance.nodeId);
    return { ...(last ?? state), mode: state.mode, threshold: state.threshold, pausedByStop: state.pausedByStop, failed: reasonOf(error), checkedAt: state.checkedAt };
  }
}

/** The folders a node's pause record names; none while it cannot be read. */
function pausedIds(marks: Marks): string[] {
  return marks instanceof Map ? [...marks.keys()].sort() : [];
}

/** Why the stop's pause was not written, from what the reconciler held; null once any pause went out or none was needed. */
function heldPause(result: NodeReconcile): string | null {
  const pauses = result.folders.flatMap((folder) => folder.changes.filter((change) => change.field === "paused" && change.text.startsWith("pause")).map((change) => ({ folder, change })));
  const held = pauses.filter(({ change }) => !change.written);
  if (!held.length) return null;
  const reason = held[0].folder.held ?? held[0].change.held ?? held[0].folder.failed;
  return /type the folder ID/.test(reason ?? "") ? "it cannot be paused without the folder ID typed" : reason ? `its pause is held: ${reason}` : null;
}

/** The sizes with `recordedSizeMargin` of each recorded folder's global size added to what it needs. */
function withMargin(sizes: FolderSizes, recorded: ReadonlyMap<string, string>): FolderSizes {
  return Object.fromEntries(Object.entries(sizes).map(([id, size]) => [id, recorded.has(id) ? { ...size, globalBytes: Math.ceil(size.globalBytes * (1 + recordedSizeMargin)) } : size]));
}

/** What a resume rests on besides the decision: the age of the sizes recorded, folders without one, and the trash a pause holds back. */
export interface ResumeContext {
  /** The oldest recorded size the decision uses, in whole minutes; null when none is used. */
  recordedMinutes: number | null;
  unsized: string[];
  trashBytes: number;
}

function resumeContext(inputs: SpaceInputs | null, now: Date): ResumeContext {
  const times = [...(inputs?.recorded.values() ?? [])].map((at) => Date.parse(at)).filter(Number.isFinite);
  return {
    recordedMinutes: times.length ? Math.max(0, Math.floor((now.getTime() - Math.min(...times)) / 60_000)) : null,
    unsized: inputs?.unsized ?? [],
    trashBytes: inputs?.trashBytes ?? 0,
  };
}

/**
 * Why a recorded pause is not resumed this round, or null: only a decision that lets the enabled node pull resumes it, on recorded sizes
 * only with their margin. The next round decides on the live sizes and pauses again if they do not fit.
 * @implNote A paused folder serves no index, so its trash cannot empty while it is paused (N3): the reason names what waits there, since the
 * typed resume on the node page may be the only way out.
 */
export function resumeHeldBy(node: LayoutNode, decision: SpaceDecision | null, plan: NodePlan, context: ResumeContext = { recordedMinutes: null, unsized: [], trashBytes: 0 }): string | null {
  const reason = resumeReason(node, decision, plan, context);
  if (!reason) return null;
  return context.trashBytes > 0 ? `${reason}; a paused folder cannot empty its trash, so ${context.trashBytes} bytes wait in it and the typed resume on the node page may be needed` : reason;
}

function resumeReason(node: LayoutNode, decision: SpaceDecision | null, plan: NodePlan, context: ResumeContext): string | null {
  if (!node.enabled) return `${node.name} is not enabled`;
  if (context.unsized.length) return `${context.unsized.join(", ")} paused with no size recorded: only the typed resume on the node page resumes it`;
  if (!decision) return "a resume waits until the node's space can be read";
  const recorded = context.recordedMinutes === null ? "" : `, on sizes recorded ${context.recordedMinutes} minutes ago with a ${recordedSizeMargin * 100}% margin`;
  if (!spaceAllowsPull(decision, plan)) return `a resume waits for a space decision that lets the node pull (it is ${decision.state}${recorded})`;
  return null;
}

/** Whether a node's own decision keeps the folder: it fits, or a raise still keeps it; never stopped, full, unknown or undecided. */
function keepsByDecision(layout: SetupLayout, nodeId: string, folderId: string, decision: Pick<SpaceDecision, "state" | "threshold"> | null): boolean {
  if (!decision || (decision.state !== "fits" && decision.state !== "raised")) return false;
  return keepsFolder(layout, nodeId, folderId, decision.threshold);
}

/**
 * Whether the folder's status counts as its size: past its first scan, not paused, with the index of every device it is shared with,
 * which 2.1.6 reports in `remoteSequence` (null while paused, empty before a remote index arrives).
 * @implNote A status without `state` is taken as indexed, as a reader that does not report it (a test's fake) cannot say otherwise.
 */
export function isIndexed(status: FolderStatus, shared: boolean): boolean {
  if (status.state === undefined) return true;
  if (!["idle", "syncing", "sync-preparing", "sync-waiting", "cleaning", "clean-waiting", "scanning", "scan-waiting"].includes(status.state)) return false;
  if (!status.stateChanged || status.stateChanged.startsWith("0001-")) return false;
  if (!status.remoteSequence) return false;
  return !shared || Object.keys(status.remoteSequence).length > 0;
}

/**
 * What the node holds of a folder at the global version: the global bytes it does not need, never more than it holds; nothing while its
 * need is not known.
 */
function heldInSync(size: FolderSize): number {
  if (size.needBytes === undefined || !Number.isFinite(size.needBytes)) return 0;
  return Math.max(0, Math.min(size.localBytes, size.globalBytes - size.needBytes));
}

/** Why the node's folders are held paused, or null: it is not enabled, or even its top priority does not fit with 10% free. */
export function stopReason(node: LayoutNode, decision: SpaceDecision | null): string | null {
  if (!node.enabled) return `${node.name} is not enabled`;
  return decision?.state === "stopped" ? `${node.name} does not fit even at its top priority` : null;
}

/** @implNote A stop keeps the plan at the committed threshold, so nothing but the pause differs from what the node had. */
function withFoldersPaused(plan: NodePlan): NodePlan {
  return { ...plan, folders: plan.folders.map((folder) => ({ ...folder, paused: true })) };
}

function isInside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Why the folder's path is no place this host may create the list in, or null; `real` is its path with every link resolved. */
async function placeProblem(roots: readonly string[], ownRoot: string | null, path: string): Promise<{ problem: string } | { real: string }> {
  if (!ownRoot) return { problem: "the node has no root known to this host" };
  const realRoot = await realOrNull(resolve(ownRoot));
  if (!realRoot || !isInside(resolve(ownRoot), resolve(path))) return { problem: "the folder is not under the node's own root" };
  const mounted = (await Promise.all(roots.map((root) => realOrNull(resolve(root))))).filter((root): root is string => root !== null);
  if (!mounted.some((root) => isInside(root, realRoot))) return { problem: "this host does not mount the node's files" };
  const real = await realOrNull(resolve(path));
  if (!real || !isInside(realRoot, real)) return { problem: "the folder does not exist under the node's root" };
  if (!(await stat(real)).isDirectory()) return { problem: "the folder's path is not a directory" };
  return { real };
}

/**
 * The hand-off list created where this host mounts the node's files at the path its Syncthing uses: the arrays under the storage root and
 * the nodes service's volumes, both mounted into the dashboard as into the nodes' containers. The folder must lie under the node's own root.
 * @implNote `O_EXCL` never truncates a list that exists and never follows a link in its place; what is there already counts only as a
 * regular file, so a link or a directory of that name is held. A Windows node's files are the host agent's to reach, so its include waits for it.
 */
export function mountedHandoffFiles(roots: readonly string[]): HandoffFiles {
  return {
    ensure: async (instance, folder) => {
      if (instance.os !== "linux") return "the host agent creates it on a Windows node";
      const place = await placeProblem(roots, instance.root, folder.path);
      if ("problem" in place) return place.problem;
      const listPath = join(place.real, handoffIgnoreFile);
      try {
        const handle = await open(listPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        await handle.close();
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return `it could not be created: ${reasonOf(error)}`;
        return (await lstat(listPath)).isFile() ? null : `a ${handoffIgnoreFile} that is not a regular file is in the way`;
      }
    },
  };
}

/** The layout `HEAD` commits, and whether that commit is on the upstream, so every host has it. */
export interface CommittedLayout {
  layout: SetupLayout;
  pushed: boolean;
}

export type NodeFileAction = { kind: "follow"; policy: LayoutNode } | { kind: "withdraw"; reason: string };

/**
 * What a node file is brought to: the committed policy with `apply = true` only for a listed, admitted, unblocked, enabled node whose
 * committed and pushed layout says `apply = true`; on any doubt only its `apply` line is taken out (the session's ruling). A disabled
 * node's trash still empties, through its trash-only contract, which no executor checks against the node file.
 */
export function nodeFileAction(committed: CommittedLayout | null, nodeId: string, options: { enabledRequired: boolean } = { enabledRequired: true }): NodeFileAction {
  if (!committed) return { kind: "withdraw", reason: "no committed layout can be read" };
  const node = committed.layout.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { kind: "withdraw", reason: "the layout does not list it" };
  if (!node.admitted) return { kind: "withdraw", reason: "it is not admitted" };
  if (blockedNodeIds(committed.layout).has(nodeId)) return { kind: "withdraw", reason: "the layout blocks it" };
  if (options.enabledRequired && !node.enabled) return { kind: "withdraw", reason: "it is not enabled" };
  if (!node.apply) return { kind: "withdraw", reason: "the committed layout does not say apply = true" };
  if (!committed.pushed) return { kind: "withdraw", reason: "the commit that says apply = true is not on the upstream yet" };
  return { kind: "follow", policy: node };
}

/**
 * The working tree's layout with each node's `apply` as the committed layout lets it act, so a dirty or unpushed `apply = true` only
 * reports, and `enabled` true only while the committed layout says so too.
 * @implNote Unlike its node file, a node that is not enabled still applies: its pause is the one change it makes. Stopping is the
 * safe direction on any doubt, and rejoining waits for a committed `enabled = true`.
 */
export function withCommittedApply(layout: SetupLayout, committed: CommittedLayout | null): SetupLayout {
  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      const committedNode = committed?.layout.nodes.find((entry) => entry.id === node.id);
      const enabled = node.enabled && (committedNode?.enabled ?? false);
      return { ...node, enabled, apply: nodeFileAction(committed, node.id, { enabledRequired: false }).kind === "follow" };
    }),
  };
}

/** What a joined device's own round produced for its answer. */
export interface JoinedRound {
  nodeFile: NodeFileAction;
  state: LayeredState | null;
  contract: HandoffContract | null;
  reconcile: { plan: NodePlan; decision: SpaceDecision | null; layout: SetupLayout; stopped: boolean } | null;
}

/** Brings a node file to the committed policy, or takes its `apply` line out; each answers whether it wrote. */
export interface NodeFiles {
  follow(instance: LocalInstance, policy: LayoutNode): Promise<boolean>;
  withdraw(instance: LocalInstance): Promise<boolean>;
}

/**
 * The node files this host may write: a Linux drive or folder node whose root lies where this host mounts the nodes' files.
 * @implNote An array's node file describes its membership and `followLayout` and `withdrawApply` never rewrite one; a Windows node's goes
 * through `agentNodeFiles`.
 */
export function mountedNodeFiles(roots: readonly string[]): NodeFiles {
  const pathOf = async (instance: LocalInstance): Promise<string | null> => {
    if (instance.os !== "linux" || instance.source === "array" || !instance.root) return null;
    const root = await realOrNull(resolve(instance.root));
    const mounted = (await Promise.all(roots.map((entry) => realOrNull(resolve(entry))))).filter((entry): entry is string => entry !== null);
    return root && mounted.some((entry) => isInside(entry, root)) ? nodeFilePath(root) : null;
  };
  return {
    follow: async (instance, policy) => {
      const path = await pathOf(instance);
      return path ? followLayout(path, policy) : false;
    },
    withdraw: async (instance) => {
      const path = await pathOf(instance);
      return path ? withdrawApply(path) : false;
    },
  };
}

/**
 * The connection round, which pulls the setup repo, then the layout round on what the pull brought.
 * @implNote The layout round runs even when the connection round fails, so a profile problem never stops a node from reaching its plan.
 */
export async function pullThenReconcile<Report>(connections: { run: () => Promise<Report> }, layouts: Pick<LayoutRound, "run">): Promise<Report> {
  try {
    return await connections.run();
  } finally {
    await layouts.run().catch((error) => console.error(`layered sync: round failed: ${reasonOf(error)}`));
  }
}

/** The list on a joined device is one of its own ops, on a Windows node the host agent's, on a Linux node this host mounts. */
export function nodeHandoffFiles(mounted: HandoffFiles, agent: HandoffFiles): HandoffFiles {
  return {
    ensure: async (instance, folder) => {
      if (instance.source === "joined") return (instance.client as unknown as ReportClient).ensureList(folder.id);
      return instance.os === "windows" ? agent.ensure(instance, folder) : mounted.ensure(instance, folder);
    },
  };
}

/** A Windows node's file is the host agent's to change, every other this host's where it mounts it. */
function nodeFilesOfHost(): NodeFiles {
  const mounted = mountedNodeFiles([storageRoot, nodeVolumesDirectory]);
  const agent = agentNodeFiles(hostAgentHandoffDirectory);
  return {
    follow: (instance, policy) => (instance.os === "windows" && instance.source === "host-agent" ? agent.follow(instance, policy) : mounted.follow(instance, policy)),
    withdraw: (instance) => (instance.os === "windows" && instance.source === "host-agent" ? agent.withdraw(instance) : mounted.withdraw(instance)),
  };
}

export const layoutRound = new LayoutRound({
  layout: () => readLayout(),
  instances: () => localInstances(),
  handoffFiles: nodeHandoffFiles(mountedHandoffFiles([storageRoot, nodeVolumesDirectory]), agentHandoffFiles(hostAgentHandoffDirectory)),
  handoffs: handoffPublisher(),
  nodeFiles: nodeFilesOfHost(),
  committedLayout: () => readCommittedLayout(),
  space: syncthingHandoffReads,
  pauses: fileLayeredPauses(layeredPausesFile),
  relayed: (queries) => relayedKeepers(peerDashboards, queries),
  notified: fileNotifiedState(`${statusDirectory}/layered/notified.json`),
  notify: (notification) => queueNotification(`${statusDirectory}/outbox`, notification),
  record: (nodeId, folderId, text) => recordDashboardActivity(nodeId, folderId, text),
});
