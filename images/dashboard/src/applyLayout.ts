import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HandoffWaitingView, LayeredChange, LayeredHandoff, LayeredSpace, LayeredState } from "./api/types.js";
import { recordDashboardActivity } from "./eventFeed.js";
import { type HandoffPublisher, type HandoffWaiting, handoffPublisher, syncthingHandoffReads } from "./handoffFeed.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances } from "./instanceResolver.js";
import { layeredStateOf, recordLayered } from "./layeredDrift.js";
import { type LayeredPauses, fileLayeredPauses } from "./layeredPauses.js";
import { type Notification, queueNotification } from "./notifyOutbox.js";
import { type NodePlan, handoffIgnoreFile, nodePlan } from "./nodePlan.js";
import { type HandoffFiles, type NodeReconcile, carriedLayoutPaths, reconcileNode } from "./reconcileNode.js";
import { nodeVolumesDirectory, statusDirectory, storageRoot } from "./settings.js";
import { type LayoutNode, type SetupLayout, blockedNodeIds, readCommittedLayout, readLayout } from "./setupRepo.js";
import { followLayout, nodeFilePath, withdrawApply } from "./nodeFile.js";
import { type FolderSize, type FolderSizes, type NodeSpace, type SpaceDecision, effectiveThreshold } from "./spacePlan.js";
import type { SyncthingFolderConfig } from "./syncthing.js";

/** What a space decision reads of a node: its disk, and each planned folder's size as its own Syncthing counts it. */
export interface SpaceReads {
  space(instance: LocalInstance): Promise<NodeSpace | null>;
  sizes(instance: LocalInstance, folderId: string): Promise<FolderSize>;
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
  return { mode, threshold, effectiveThreshold: threshold, drift: [], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: null, problems: [], failed: null, checkedAt, space: null, stopped: null, handoff: null };
}

function spaceView(decision: SpaceDecision | null): LayeredSpace | null {
  return decision ? { state: decision.state, threshold: decision.threshold, neededBytes: decision.neededBytes, availableBytes: decision.availableBytes } : null;
}

/** A node of this host as the first pass of a round leaves it: planned at its committed threshold with its space decided, or why not. */
type Prepared =
  | { kind: "unlisted" }
  | { kind: "unadmitted"; node: LayoutNode }
  | { kind: "blocked"; node: LayoutNode; problems: string[] }
  | { kind: "failed"; node: LayoutNode; error: unknown }
  | { kind: "planned"; node: LayoutNode; localFolders: Set<string>; plan: NodePlan; decision: SpaceDecision | null };

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
      const spaces = new Map([...prepared].flatMap(([nodeId, entry]) => (entry.kind === "planned" ? [[nodeId, entry.decision] as const] : [])));
      for (const instance of instances) {
        const state = await this.nodeState(gated, instance, instances, prepared.get(instance.nodeId) as Prepared, spaces);
        if (!state) continue;
        const handoff = await this.handoffView(instance, state.checkedAt);
        this.recordHandoffActivity(instance, state, handoff);
        states.set(instance.nodeId, { ...state, handoff });
      }
    }
    recordLayered(states);
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

  private async clearHandoffs(instance: LocalInstance, apply: boolean): Promise<void> {
    await this.dependencies.handoffs?.clear(instance.nodeId, instance, apply).catch((error) => console.error(`layered sync: no hand-off contract written for ${instance.nodeId}: ${reasonOf(error)}`));
  }

  private async publishHandoffs(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], localFolders: ReadonlySet<string>, decision: SpaceDecision | null, spaces: ReadonlyMap<string, SpaceDecision | null>): Promise<number | null> {
    const publisher = this.dependencies.handoffs;
    if (!publisher) return null;
    try {
      return await publisher.publish({ layout, nodeId: instance.nodeId, localFolders, instance, instances, decided: { decision }, keeperSpace: (nodeId) => spaces.get(nodeId) ?? null });
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
   * The space decision for the node's plan at its committed threshold; null when its disk cannot be read.
   * @implNote A folder whose size cannot be read has none, which makes a folder the node keeps `unknown`.
   */
  private async decide(instance: LocalInstance, plan: NodePlan): Promise<SpaceDecision | null> {
    const reads = this.dependencies.space;
    if (!reads) return null;
    const space = await reads.space(instance).catch(() => null);
    if (!space) return null;
    const sizes: FolderSizes = {};
    for (const folder of plan.folders) {
      const size = await reads.sizes(instance, folder.id).catch(() => null);
      if (size && Number.isFinite(size.globalBytes) && Number.isFinite(size.localBytes)) sizes[folder.id] = size;
    }
    return effectiveThreshold(plan, sizes, space);
  }

  /** @implNote Every node of the host is planned and decided before any is reconciled, so each hand-off sees the space decision of every keeper of this round. */
  private async prepare(layout: SetupLayout, instance: LocalInstance): Promise<Prepared> {
    const node = layout.nodes.find((entry) => entry.id === instance.nodeId);
    if (!node) return { kind: "unlisted" };
    if (!node.admitted) return { kind: "unadmitted", node };
    try {
      const configured = (await callSyncthing(instance, (client) => client.folders())) ?? [];
      const localFolders = carriedLayoutPaths(layout, node.id, new Set(configured.map((folder: SyncthingFolderConfig) => folder.id)));
      const plan = nodePlan(layout, node.id, localFolders);
      if (!plan) return { kind: "unlisted" };
      if (plan.problems.length) return { kind: "blocked", node, problems: plan.problems };
      return { kind: "planned", node, localFolders, plan, decision: await this.decide(instance, plan) };
    } catch (error) {
      return { kind: "failed", node, error };
    }
  }

  /**
   * @implNote A raise plans at the decision's threshold, so the folders it drops turn send-only; any other decision plans at the committed
   * threshold, and the reconciler holds every type-up the decision does not allow.
   */
  private async nodeState(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], prepared: Prepared, spaces: ReadonlyMap<string, SpaceDecision | null>): Promise<LayeredState | null> {
    if (prepared.kind === "unlisted") {
      await this.clearHandoffs(instance, false);
      return null;
    }
    const node = prepared.node;
    const checkedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const state = emptyState(node.apply ? "apply" : "report", node.threshold, checkedAt);
    if (prepared.kind === "unadmitted") {
      await this.clearHandoffs(instance, node.apply);
      return { ...state, problems: [`${node.name} is not admitted yet`] };
    }
    if (prepared.kind === "blocked") {
      await this.clearHandoffs(instance, node.apply);
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
        handoffFiles: this.dependencies.handoffFiles,
        onWritten: (folderId, text) => this.dependencies.record(instance.nodeId, folderId, text),
        readBackDelaysMs: this.dependencies.readBackDelaysMs ?? defaultReadBackDelaysMs,
      });
      const pendingHandoffs = await this.publishHandoffs(layout, instance, instances, localFolders, decision, spaces);
      await this.notifyPauses(instance, result, stopped);
      return { ...state, effectiveThreshold: plan.appliedThreshold, space: spaceView(decision), stopped, pendingHandoffs, drift: driftOf(result), missing: result.missing.map((folder) => folder.label), unplanned: result.unplanned, unknownDevices: result.unknownDevices, nodeOnlyIgnores: result.nodeOnlyIgnores.map(nodeOnlyText), failed: result.failed.length ? result.failed.join("; ") : null };
    } catch (error) {
      return this.failedState(instance, node, state, error);
    }
  }

  /** One notification for a round that paused the node's folders, and one for a round that resumed them. */
  private async notifyPauses(instance: LocalInstance, result: NodeReconcile, stopped: string | null): Promise<void> {
    const notify = this.dependencies.notify;
    const written = result.folders.filter((folder) => folder.written.includes("paused"));
    if (!notify || !written.length) return;
    const count = `${written.length} ${written.length === 1 ? "folder" : "folders"}`;
    const notification: Notification = stopped
      ? { priority: 4, tags: "warning", title: `${instance.name} stopped`, message: `${stopped}: ${count} paused, so it pulls nothing and hands nothing off. It resumes once it fits with 10% free, or when enabled = true is committed again.` }
      : { priority: 3, tags: "white_check_mark", title: `${instance.name} resumed`, message: `${count} resumed: it syncs again and sends what it gathered while stopped.` };
    await notify(notification).catch((error) => console.error(`layered sync: no notification queued for ${instance.name}: ${reasonOf(error)}`));
  }

  private async failedState(instance: LocalInstance, node: LayoutNode, state: LayeredState, error: unknown): Promise<LayeredState> {
    await this.clearHandoffs(instance, node.apply);
    const last = layeredStateOf(instance.nodeId);
    return { ...(last ?? state), mode: state.mode, threshold: state.threshold, failed: reasonOf(error), checkedAt: state.checkedAt };
  }
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
 * committed and pushed layout says `apply = true`; on any doubt only its `apply` line is taken out (the session's ruling).
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
 * @implNote Unlike its node file, a node that is not enabled still applies, since its pause is the one change it makes: stopping is the
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

/** Brings a node file to the committed policy, or takes its `apply` line out; each answers whether it wrote. */
export interface NodeFiles {
  follow(instance: LocalInstance, policy: LayoutNode): Promise<boolean>;
  withdraw(instance: LocalInstance): Promise<boolean>;
}

/**
 * The node files this host may write: a Linux drive or folder node whose root lies where this host mounts the nodes' files.
 * @implNote An array's node file describes its membership and `followLayout` and `withdrawApply` never rewrite one; a Windows node's is the
 * host agent's to write (phase 6), so it waits, and with it every Windows node's hand-off.
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

export const layoutRound = new LayoutRound({
  layout: () => readLayout(),
  instances: () => localInstances(),
  handoffFiles: mountedHandoffFiles([storageRoot, nodeVolumesDirectory]),
  handoffs: handoffPublisher(),
  nodeFiles: mountedNodeFiles([storageRoot, nodeVolumesDirectory]),
  committedLayout: () => readCommittedLayout(),
  space: syncthingHandoffReads,
  pauses: fileLayeredPauses(`${statusDirectory}/layered/paused.json`),
  notify: (notification) => queueNotification(`${statusDirectory}/outbox`, notification),
  record: (nodeId, folderId, text) => recordDashboardActivity(nodeId, folderId, text),
});
