import type { NodeRestartState, RestartAnswer, RestartBody } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, requireLocal } from "../instanceResolver.js";
import type { AnyRoute, WriteNote } from "../routes.js";

/**
 * Whether a restart needs the node's name typed.
 * @implNote While an array or the host's own native node (the PC's folders) restarts, its folders stop syncing; a container node such as
 * the test peer restarts with a click, as it is paused with one.
 */
export function isRestartConfirmRequired(instance: LocalInstance): boolean {
  return instance.source === "array" || instance.source === "host-agent";
}

/** Whether the node's Syncthing needs a restart before a saved change takes effect. */
export async function requiresRestart(instance: LocalInstance): Promise<boolean> {
  const answer = await callSyncthing(instance, (client) => client.request<{ requiresRestart?: unknown } | null>("GET", "/config/restart-required"));
  return answer?.requiresRestart === true;
}

export async function restartState(instance: ResolvedInstance): Promise<NodeRestartState> {
  const local = requireLocal(instance);
  return { restartRequired: await requiresRestart(local), confirmRequired: isRestartConfirmRequired(local) };
}

function confirmOf(body: unknown): unknown {
  return typeof body === "object" && body !== null ? (body as RestartBody).confirm : undefined;
}

export interface NodeRestart {
  answer: RestartAnswer;
  note: WriteNote;
}

/**
 * Restarts the node's Syncthing, as its own Restart does.
 * @implNote Every node runs with `--no-restart`, so Syncthing exits after answering and its keeper starts it again: the nodes service,
 * the host agent's watcher, or Docker for the test peer. Until then a write to it answers 503 and the event feed follows the restart.
 */
export async function restartNode(instance: ResolvedInstance, body: unknown): Promise<NodeRestart> {
  const local = requireLocal(instance);
  if (isRestartConfirmRequired(local) && confirmOf(body) !== local.name) throw new RequestError(400, `type ${local.name} to restart its Syncthing: its folders stop syncing until it is back`);
  await callSyncthing(local, (client) => client.request("POST", "/system/restart"));
  return { answer: { restarting: true }, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: restarted its Syncthing` } };
}

export function restartRoutes(node: (segment: string) => Promise<ResolvedInstance>): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/restart-required$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await restartState(await node(nodeId))),
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/restart$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const restart = await restartNode(await node(nodeId), await readBody(request));
        sendJson(response, 200, restart.answer);
        return restart.note;
      },
    },
  ];
}
