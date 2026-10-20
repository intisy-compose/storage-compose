import { readFile } from "node:fs/promises";
import type { NodeRegistryEntry } from "./api/types.js";
import { hostAgentExpected, hostAgentHeartbeatFile, hostAgentSyncthingHost } from "./settings.js";

/** `host-agent/status/heartbeat.json`, schema 1, written by the Windows host agent every 5 s. */
export interface HostAgentHeartbeat {
  heartbeat: string;
  heartbeatEpoch: number;
  host: string;
  os: string;
  state: "running" | "stopped" | "removed";
  problems: string[];
  nodes: HostAgentNode[];
}

export interface HostAgentNode {
  id: string;
  name: string;
  kind: "drive" | "folder";
  threshold: number;
  assigned: string[];
  root: string;
  syncthing: { state: string; deviceId: string | null; guiPort: number | null; listenPort: number | null; apiKey: string | null; problem: string | null } | null;
}

const staleAfterSeconds = 30;

export async function readHeartbeat(): Promise<HostAgentHeartbeat | null> {
  try {
    return JSON.parse((await readFile(hostAgentHeartbeatFile, "utf8")).replace(/^﻿/, "")) as HostAgentHeartbeat;
  } catch {
    return null;
  }
}

export function isAgentAlive(heartbeat: HostAgentHeartbeat | null, now = Date.now()): boolean {
  return heartbeat !== null && heartbeat.state === "running" && now / 1000 - heartbeat.heartbeatEpoch <= staleAfterSeconds;
}

/** Why the agent counts as not running, or null; only where an agent belongs (Windows). */
export function agentProblem(heartbeat: HostAgentHeartbeat | null, now = Date.now()): string | null {
  if (!hostAgentExpected) return null;
  if (!heartbeat) return "host agent not running: it has never written its heartbeat";
  if (heartbeat.state !== "running") return `host agent not running: it is ${heartbeat.state}`;
  const age = Math.round(now / 1000 - heartbeat.heartbeatEpoch);
  return age > staleAfterSeconds ? `host agent not running: its heartbeat is ${age} s old` : null;
}

/** The agent's native nodes as registry entries; they are absent while the agent is not alive. */
export function agentEntries(heartbeat: HostAgentHeartbeat | null, now = Date.now()): NodeRegistryEntry[] {
  if (!heartbeat) return [];
  const alive = isAgentAlive(heartbeat, now);
  return (heartbeat.nodes ?? []).map((node) => {
    const syncthing = node.syncthing;
    const reachable = alive && syncthing?.state === "running" && syncthing.guiPort && syncthing.apiKey;
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      threshold: node.threshold ?? 0,
      assigned: node.assigned ?? [],
      root: node.root,
      present: alive,
      space: { size: null, used: null },
      syncthing: reachable ? { url: `http://${hostAgentSyncthingHost}:${syncthing.guiPort}`, apiKey: syncthing.apiKey! } : null,
      updated: heartbeat.heartbeat,
    };
  });
}
