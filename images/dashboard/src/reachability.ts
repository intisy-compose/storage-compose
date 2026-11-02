import type { Bridge, ConnectionProfile, HostNetwork, NodeAddresses, PeerTable } from "./api/types.js";

/** @implNote A LAN Windows marks `Public` is firewalled to the tailnet range (spec section 5), so it carries no LAN method. */
function isUsable(profile: ConnectionProfile, network: HostNetwork): boolean {
  if (network.kind === "lan") return profile.methods.lan && network.category !== "Public";
  if (network.kind === "tailnet") return profile.methods.tailnet;
  return profile.methods.nat;
}

/** @implNote A public address is reached from any network, so only a LAN or tailnet address needs the dialler on it too. */
export function canReach(profile: ConnectionProfile, own: HostNetwork[], network: HostNetwork): boolean {
  if (!isUsable(profile, network)) return false;
  return network.kind === "public" || own.some((ownNetwork) => ownNetwork.kind === network.kind && isUsable(profile, ownNetwork));
}

/** @implNote One end dialling the other is a connection, so either direction is enough. */
function isDirect(profile: ConnectionProfile, first: NodeAddresses, second: NodeAddresses): boolean {
  return second.networks.some((network) => canReach(profile, first.networks, network)) || first.networks.some((network) => canReach(profile, second.networks, network));
}

function reachesBridge(profile: ConnectionProfile, node: NodeAddresses, bridge: Bridge): boolean {
  return bridge.addresses.some((network) => canReach(profile, node.networks, network));
}

function isBridged(profile: ConnectionProfile, bridges: Bridge[], first: NodeAddresses, second: NodeAddresses): boolean {
  return profile.relays.bridges && bridges.some((bridge) => reachesBridge(profile, first, bridge) && reachesBridge(profile, second, bridge));
}

/**
 * Every pair of the table's nodes that would share no method under `profile`, each pair and the list sorted by node id.
 * @implNote Syncthing's public relays are taken to reach every node, as every node has a way out to the internet today.
 */
export function pairsWithoutCommonMethod(profile: ConnectionProfile, table: PeerTable): Array<[string, string]> {
  if (profile.relays.public) return [];
  const nodes = [...table.nodes].sort((first, second) => first.nodeId.localeCompare(second.nodeId));
  return nodes.flatMap((first, index) =>
    nodes
      .slice(index + 1)
      .filter((second) => !isDirect(profile, first, second) && !isBridged(profile, table.bridges, first, second))
      .map((second): [string, string] => [first.nodeId, second.nodeId]),
  );
}

/** The pairs `after` strands that `before` did not. */
export function newlyStrandedPairs(before: ConnectionProfile, after: ConnectionProfile, table: PeerTable): Array<[string, string]> {
  const already = new Set(pairsWithoutCommonMethod(before, table).map((pair) => pair.join(" ")));
  return pairsWithoutCommonMethod(after, table).filter((pair) => !already.has(pair.join(" ")));
}
