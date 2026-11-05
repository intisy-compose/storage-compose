import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { LayeredChange, LayeredState } from "./api/types.js";
import { recordDashboardActivity } from "./eventFeed.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances } from "./instanceResolver.js";
import { layeredStateOf, recordLayered } from "./layeredDrift.js";
import { handoffIgnoreFile, nodePlan } from "./nodePlan.js";
import { type HandoffFiles, type NodeReconcile, carriedLayoutPaths, reconcileNode } from "./reconcileNode.js";
import { nodeVolumesDirectory, storageRoot } from "./settings.js";
import { type SetupLayout, readLayout } from "./setupRepo.js";
import type { SyncthingFolderConfig } from "./syncthing.js";

export interface LayoutRoundDependencies {
  /** The layout as the last pull left it; null while the setup repo holds none. */
  layout: () => Promise<SetupLayout | null>;
  instances: () => Promise<LocalInstance[]>;
  handoffFiles: HandoffFiles;
  /** Enters one written change in Activity. */
  record: (nodeId: string, folderId: string, text: string) => void;
  readBackDelaysMs?: readonly number[];
  now?: () => Date;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function driftOf(result: NodeReconcile): LayeredChange[] {
  return result.folders.flatMap((folder) =>
    folder.changes.map((change) => ({ folderId: folder.folderId, label: folder.label, field: change.field, text: change.text, written: folder.written.includes(change.field), held: folder.written.includes(change.field) ? null : folder.held })),
  );
}

function emptyState(mode: LayeredState["mode"], threshold: number, checkedAt: string): LayeredState {
  return { mode, threshold, effectiveThreshold: threshold, drift: [], missing: [], unplanned: [], unknownDevices: [], pendingHandoffs: null, problems: [], failed: null, checkedAt };
}

/**
 * Each round brings this host's nodes to their layered plans from the shared layout, or only reports how they differ.
 * @implNote The plan is made at the committed threshold and no hand-off is decided yet, so `effectiveThreshold` is the committed one and
 * `pendingHandoffs` null. A round never confirms for an array, so an array's changes always wait for the folder ID typed.
 */
export class LayoutRound {
  constructor(private readonly dependencies: LayoutRoundDependencies) {}

  async run(): Promise<void> {
    const layout = await this.dependencies.layout();
    const states = new Map<string, LayeredState>();
    if (layout) {
      for (const instance of await this.dependencies.instances()) {
        const state = await this.nodeState(layout, instance);
        if (state) states.set(instance.nodeId, state);
      }
    }
    recordLayered(states);
  }

  private async nodeState(layout: SetupLayout, instance: LocalInstance): Promise<LayeredState | null> {
    const node = layout.nodes.find((entry) => entry.id === instance.nodeId);
    if (!node) return null;
    const checkedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const state = emptyState(node.apply ? "apply" : "report", node.threshold, checkedAt);
    if (!node.admitted) return { ...state, problems: [`${node.name} is not admitted yet`] };
    try {
      const configured = (await callSyncthing(instance, (client) => client.folders())) ?? [];
      const plan = nodePlan(layout, node.id, carriedLayoutPaths(layout, node.id, new Set(configured.map((folder: SyncthingFolderConfig) => folder.id))));
      if (!plan) return null;
      if (plan.problems.length) return { ...state, problems: plan.problems };
      const result = await reconcileNode(instance, plan, {
        apply: node.apply,
        layout,
        handoffFiles: this.dependencies.handoffFiles,
        onWritten: (folderId, text) => this.dependencies.record(instance.nodeId, folderId, text),
        readBackDelaysMs: this.dependencies.readBackDelaysMs ?? defaultReadBackDelaysMs,
      });
      return { ...state, effectiveThreshold: plan.appliedThreshold, drift: driftOf(result), missing: result.missing.map((folder) => folder.label), unplanned: result.unplanned, unknownDevices: result.unknownDevices };
    } catch (error) {
      const last = layeredStateOf(instance.nodeId);
      return { ...(last ?? state), mode: state.mode, threshold: state.threshold, failed: reasonOf(error), checkedAt };
    }
  }
}

function isInside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/**
 * The hand-off list created where this host mounts the node's files at the path its Syncthing uses: the arrays under the storage root and
 * the nodes service's volumes, both mounted into the dashboard as into the nodes' containers.
 * @implNote `O_EXCL` never truncates a list that exists, and refuses to follow a link in its place. A Windows node's files are the host agent's
 * to reach, so its include waits for it.
 */
export function mountedHandoffFiles(roots: readonly string[]): HandoffFiles {
  return {
    ensure: async (instance, folder) => {
      if (instance.os !== "linux") return false;
      const path = resolve(folder.path);
      if (!roots.some((root) => isInside(resolve(root), path))) return false;
      try {
        const real = await realpath(path);
        if (!roots.some((root) => isInside(resolve(root), real)) || !(await stat(real)).isDirectory()) return false;
        const handle = await open(join(real, handoffIgnoreFile), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        await handle.close();
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EEXIST";
      }
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
  record: (nodeId, folderId, text) => recordDashboardActivity(nodeId, folderId, text),
});
