import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HandoffWaitingView, LayeredChange, LayeredHandoff, LayeredState } from "./api/types.js";
import { recordDashboardActivity } from "./eventFeed.js";
import { type HandoffPublisher, type HandoffWaiting, handoffPublisher } from "./handoffFeed.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances } from "./instanceResolver.js";
import { layeredStateOf, recordLayered } from "./layeredDrift.js";
import { handoffIgnoreFile, nodePlan } from "./nodePlan.js";
import { type HandoffFiles, type NodeReconcile, carriedLayoutPaths, reconcileNode } from "./reconcileNode.js";
import { nodeVolumesDirectory, storageRoot } from "./settings.js";
import { type LayoutNode, type SetupLayout, blockedNodeIds, readLayout } from "./setupRepo.js";
import { followLayout, nodeFilePath } from "./nodeFile.js";
import type { SyncthingFolderConfig } from "./syncthing.js";

export interface LayoutRoundDependencies {
  /** The layout as the last pull left it; null while the setup repo holds none. */
  layout: () => Promise<SetupLayout | null>;
  instances: () => Promise<LocalInstance[]>;
  handoffFiles: HandoffFiles;
  /** Writes each node's hand-off contract; a round without one writes none. */
  handoffs?: HandoffPublisher;
  /** Brings the node's own `.storage/node.toml` to its layout policy; true when it wrote. A round without one leaves node files alone. */
  nodeFiles?: (instance: LocalInstance, policy: LayoutNode) => Promise<boolean>;
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
  return { mode, threshold, effectiveThreshold: threshold, drift: [], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: null, problems: [], failed: null, checkedAt, handoff: null };
}

/**
 * Each round brings this host's nodes to their layered plans from the shared layout, or only reports how they differ, and writes each
 * node's hand-off contract, an empty one whenever the node cannot be planned, so an executor never acts on an older round's list.
 * @implNote The plan is made at the committed threshold, so `effectiveThreshold` is the committed one. A round never confirms for an
 * array, so an array's changes always wait for the folder ID typed.
 */
export class LayoutRound {
  constructor(private readonly dependencies: LayoutRoundDependencies) {}

  async run(): Promise<void> {
    const layout = await this.dependencies.layout();
    const states = new Map<string, LayeredState>();
    if (layout) {
      const instances = await this.dependencies.instances();
      for (const instance of instances) {
        const state = await this.nodeState(layout, instance, instances);
        if (state) states.set(instance.nodeId, { ...state, handoff: await this.handoffView(instance, state.checkedAt) });
      }
    }
    recordLayered(states);
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
    return { writtenAt: last.contract.writtenAt, entries: last.contract.entries.length, waiting: this.sinceOf(instance.nodeId, last.contract.waiting, checkedAt), notes: [...last.contract.notes], space, result };
  }

  private async clearHandoffs(instance: LocalInstance, apply: boolean): Promise<void> {
    await this.dependencies.handoffs?.clear(instance.nodeId, instance, apply).catch((error) => console.error(`layered sync: no hand-off contract written for ${instance.nodeId}: ${reasonOf(error)}`));
  }

  private async publishHandoffs(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[], localFolders: ReadonlySet<string>): Promise<number | null> {
    const publisher = this.dependencies.handoffs;
    if (!publisher) return null;
    try {
      return await publisher.publish({ layout, nodeId: instance.nodeId, localFolders, instance, instances });
    } catch (error) {
      console.error(`layered sync: no hand-off contract written for ${instance.nodeId}: ${reasonOf(error)}`);
      return null;
    }
  }

  /**
   * The node file follows the layout's policy, `apply` only for an admitted node the layout does not block, so the executors' own check of
   * the node file turns true only after the layout commits it, and false again the round it is taken back.
   */
  private async followNodeFile(layout: SetupLayout, instance: LocalInstance, node: LayoutNode): Promise<void> {
    const follow = this.dependencies.nodeFiles;
    if (!follow) return;
    const policy = { ...node, apply: node.apply && node.admitted && !blockedNodeIds(layout).has(node.id) };
    try {
      if (await follow(instance, policy)) this.dependencies.record(instance.nodeId, null, `${instance.name}: node file follows the layout, threshold ${policy.threshold}, apply ${policy.apply ? "on" : "off"}`);
    } catch (error) {
      console.error(`layered sync: ${instance.name}'s node file does not follow the layout: ${reasonOf(error)}`);
    }
  }

  private async nodeState(layout: SetupLayout, instance: LocalInstance, instances: LocalInstance[]): Promise<LayeredState | null> {
    const node = layout.nodes.find((entry) => entry.id === instance.nodeId);
    if (!node) {
      await this.clearHandoffs(instance, false);
      return null;
    }
    await this.followNodeFile(layout, instance, node);
    const checkedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const state = emptyState(node.apply ? "apply" : "report", node.threshold, checkedAt);
    if (!node.admitted) {
      await this.clearHandoffs(instance, node.apply);
      return { ...state, problems: [`${node.name} is not admitted yet`] };
    }
    try {
      const configured = (await callSyncthing(instance, (client) => client.folders())) ?? [];
      const localFolders = carriedLayoutPaths(layout, node.id, new Set(configured.map((folder: SyncthingFolderConfig) => folder.id)));
      const plan = nodePlan(layout, node.id, localFolders);
      if (!plan || plan.problems.length) await this.clearHandoffs(instance, node.apply);
      if (!plan) return null;
      if (plan.problems.length) return { ...state, problems: plan.problems };
      const result = await reconcileNode(instance, plan, {
        apply: node.apply,
        layout,
        handoffFiles: this.dependencies.handoffFiles,
        onWritten: (folderId, text) => this.dependencies.record(instance.nodeId, folderId, text),
        readBackDelaysMs: this.dependencies.readBackDelaysMs ?? defaultReadBackDelaysMs,
      });
      const pendingHandoffs = await this.publishHandoffs(layout, instance, instances, localFolders);
      return { ...state, effectiveThreshold: plan.appliedThreshold, pendingHandoffs, drift: driftOf(result), missing: result.missing.map((folder) => folder.label), unplanned: result.unplanned, unknownDevices: result.unknownDevices, nodeOnlyIgnores: result.nodeOnlyIgnores.map(nodeOnlyText), failed: result.failed.length ? result.failed.join("; ") : null };
    } catch (error) {
      await this.clearHandoffs(instance, node.apply);
      const last = layeredStateOf(instance.nodeId);
      return { ...(last ?? state), mode: state.mode, threshold: state.threshold, failed: reasonOf(error), checkedAt };
    }
  }
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

/**
 * The node files this host may bring to the layout: a Linux drive or folder node whose root lies where this host mounts the nodes' files.
 * @implNote An array's node file is on every member and describes the membership, so it is never followed; a Windows node's is the host
 * agent's to write (phase 6), so it waits, and with it every Windows node's hand-off.
 */
export function mountedNodeFiles(roots: readonly string[]): (instance: LocalInstance, policy: LayoutNode) => Promise<boolean> {
  return async (instance, policy) => {
    if (instance.os !== "linux" || instance.source === "array" || !instance.root) return false;
    const root = await realOrNull(resolve(instance.root));
    const mounted = (await Promise.all(roots.map((entry) => realOrNull(resolve(entry))))).filter((entry): entry is string => entry !== null);
    if (!root || !mounted.some((entry) => isInside(entry, root))) return false;
    return followLayout(nodeFilePath(root), policy);
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
  record: (nodeId, folderId, text) => recordDashboardActivity(nodeId, folderId, text),
});
