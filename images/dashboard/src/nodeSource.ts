import type { SettingsKeeper } from "./api/keeperText.js";
import type { StorageNode } from "./api/types.js";
import { nodeVolumesDirectory } from "./settings.js";

/** Where this host knows a node from: the mounter's arrays, the registry the mounter and nodes service write, the Windows host agent, or a joined device's own report. */
export type LocalNodeSource = "array" | "registry" | "host-agent" | "joined";

interface SourcedNode {
  nodeId: string;
  source: LocalNodeSource;
  root: string | null;
}

/**
 * What rewrites some of the node's Syncthing settings at each start: the host agent for its Windows nodes, the nodes service for every
 * array and for each node volume it runs, the cluster included, whose start script applies the same connection profile with the nodes
 * service's script; nothing for any other Syncthing.
 * @implNote The nodes service runs a registry node's Syncthing only when its root lies under the node volumes (`wanted_nodes` in images/nodes/nodes.sh);
 * the test peer's root does not, as it runs its own.
 */
export function settingsKeeperOf(node: SourcedNode): SettingsKeeper | null {
  if (node.source === "host-agent") return "host-agent";
  if (node.source === "array") return "nodes-service";
  return node.root?.startsWith(nodeVolumesDirectory) ? "nodes-service" : null;
}

/**
 * Whether a restart needs the node's name typed.
 * @implNote While an array or the host's own native node (the PC's folders) restarts, its folders stop syncing; a container node such as
 * the test peer restarts with a click, as it is paused with one.
 */
export function isRestartConfirmRequired(node: Pick<SourcedNode, "source">): boolean {
  return node.source === "array" || node.source === "host-agent";
}

/** The rules a local node's page applies before the server does, so a field the server refuses shows read only and a typed name stays asked for. */
export function localNodeRules(source: LocalNodeSource, nodeId: string, root: string | null): Pick<StorageNode, "keeper" | "restartConfirmRequired"> {
  return { keeper: settingsKeeperOf({ nodeId, source, root }), restartConfirmRequired: isRestartConfirmRequired({ source }) };
}
