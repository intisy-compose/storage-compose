import { readFile, rename, writeFile } from "node:fs/promises";
import type { LocalInstance } from "./instanceResolver.js";
import type { LayoutNode } from "./setupRepo.js";
import type { HandoffFiles } from "./reconcileNode.js";

/** How old a policy file may be before the host agent takes `apply` back out of the node file, as a contract may be before it is refused. */
export const agentPolicyMaxAgeSeconds = 300;

/** What the host agent should make of its Windows node's file; replaced each round, withdrawn by the agent when it goes stale. */
export type AgentPolicy =
  | { schema: 1; nodeId: string; writtenAt: string; action: "follow"; policy: { threshold: number; assigned: string[]; access: LayoutNode["access"] } }
  | { schema: 1; nodeId: string; writtenAt: string; action: "withdraw"; reason: string };

export interface AgentListRequest {
  schema: 1;
  nodeId: string;
  writtenAt: string;
  folders: Record<string, string>;
}

export interface AgentListAnswer {
  folders: Record<string, { path: string; state: "ready" | "refused"; problem?: string }>;
}

function policyFile(directory: string, nodeId: string): string {
  return `${directory}/${nodeId}.policy.json`;
}

export function listRequestFile(directory: string, nodeId: string): string {
  return `${directory}/${nodeId}.lists.json`;
}

export function listAnswerFile(directory: string, nodeId: string): string {
  return `${directory}/${nodeId}.lists.result.json`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.new`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.new`, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * A Windows node's file is the host agent's to change: the round leaves it a policy file beside the node's contract, every round, and the
 * agent follows the file while it is fresh and withdraws `apply` once it is not.
 * @implNote The answer says whether the action changed, so Activity gets one entry and not one per round, as a mounted node's file does.
 */
export function agentNodeFiles(directory: string, now: () => Date = () => new Date()): { follow: (instance: LocalInstance, policy: LayoutNode) => Promise<boolean>; withdraw: (instance: LocalInstance, reason?: string) => Promise<boolean> } {
  const last = new Map<string, string>();
  const write = async (instance: LocalInstance, action: AgentPolicy): Promise<boolean> => {
    await writeJson(policyFile(directory, instance.nodeId), action);
    const key = action.action === "follow" ? `follow ${JSON.stringify(action.policy)}` : "withdraw";
    const changed = last.get(instance.nodeId) !== key;
    last.set(instance.nodeId, key);
    return changed && (action.action === "follow" || last.size > 0);
  };
  return {
    follow: (instance, policy) => write(instance, { schema: 1, nodeId: instance.nodeId, writtenAt: now().toISOString(), action: "follow", policy: { threshold: policy.threshold, assigned: [...policy.assigned], access: policy.access } }),
    withdraw: (instance, reason = "the node may not act") => write(instance, { schema: 1, nodeId: instance.nodeId, writtenAt: now().toISOString(), action: "withdraw", reason }),
  };
}

/**
 * The hand-off list on a Windows node: this round asks the host agent for it, and it counts once the agent says it exists at that path.
 * @implNote The reconciler's order (ignored, then created, then included) holds across rounds: the agent also refuses until the folder's
 * `.stignore` names the list, so the file cannot be scanned as an ordinary one.
 */
export function agentHandoffFiles(directory: string, now: () => Date = () => new Date()): HandoffFiles {
  return {
    ensure: async (instance, folder) => {
      const answer = await readJson<AgentListAnswer>(listAnswerFile(directory, instance.nodeId));
      const entry = answer?.folders?.[folder.id];
      if (entry?.state === "ready" && entry.path === folder.path) return null;
      const request = await readJson<AgentListRequest>(listRequestFile(directory, instance.nodeId));
      await writeJson(listRequestFile(directory, instance.nodeId), { schema: 1, nodeId: instance.nodeId, writtenAt: now().toISOString(), folders: { ...(request?.folders ?? {}), [folder.id]: folder.path } } satisfies AgentListRequest);
      return entry?.state === "refused" && entry.path === folder.path ? `the host agent could not create it: ${entry.problem ?? "no reason given"}` : "the host agent creates it within a few seconds";
    },
  };
}
