import type { LayeredState } from "./api/types.js";

let states: ReadonlyMap<string, LayeredState> = new Map();

/** The last layout round's state of each of this host's nodes the layout lists. */
export function recordLayered(next: ReadonlyMap<string, LayeredState>): void {
  states = next;
}

const joinedStates = new Map<string, { deviceId: string; state: LayeredState }>();

/** A joined device's node as its own report round left it; a round of its own, so a host's round never drops it. */
export function recordJoinedLayered(nodeId: string, deviceId: string, state: LayeredState): void {
  joinedStates.set(nodeId, { deviceId, state });
}

export function layeredStateOf(nodeId: string): LayeredState | null {
  return states.get(nodeId) ?? joinedStates.get(nodeId)?.state ?? null;
}

/** The joined device's node state, for the node page that knows the device only by its Syncthing ID. */
export function joinedLayeredOfDevice(deviceId: string): LayeredState | null {
  return [...joinedStates.values()].find((entry) => entry.deviceId === deviceId)?.state ?? null;
}
