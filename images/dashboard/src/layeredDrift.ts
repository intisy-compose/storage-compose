import type { LayeredState } from "./api/types.js";

let states: ReadonlyMap<string, LayeredState> = new Map();

/** The last layout round's state of each of this host's nodes the layout lists. */
export function recordLayered(next: ReadonlyMap<string, LayeredState>): void {
  states = next;
}

export function layeredStateOf(nodeId: string): LayeredState | null {
  return states.get(nodeId) ?? null;
}
