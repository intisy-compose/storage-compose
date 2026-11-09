import type { NodeAdmission, NodeAdmissionBody } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalNodeInfo, callSyncthing, findLocalNode } from "../instanceResolver.js";
import { joinedDeviceIdOf, joinedNodeInfos } from "../joinedNodes.js";
import { checkedLayout, editNodePolicy, layoutVersion, validPriority } from "../layoutEdit.js";
import type { AnyRoute } from "../routeTypes.js";
import { setupRepoDirectory } from "../settings.js";
import { type SetupLayout, parseLayout, saveLayout, upsertDevice } from "../setupRepo.js";
import { decodedSegment } from "./devices.js";
import { layoutTextOf, pullAfterConflict, requireBase } from "./priorities.js";

/** This host's nodes the layout does not admit and nobody refused: a node file with no admitted entry, a stick made offline included. */
export function waitingAdmissions(layout: SetupLayout | null, infos: LocalNodeInfo[], host: string): NodeAdmission[] {
  if (!layout) return [];
  return infos.flatMap((info) => {
    const entry = layout.nodes.find((node) => node.id === info.nodeId);
    if (entry?.admitted || entry?.refused) return [];
    return [{ nodeId: info.nodeId, name: info.name, source: info.source, host, threshold: info.threshold, listed: entry !== undefined }];
  });
}

export interface AdmissionSources {
  repository: string;
  findNode(nodeId: string): Promise<LocalNodeInfo | null>;
  /** The node's own Syncthing device ID, which the layout's device entry carries. */
  deviceId(info: LocalNodeInfo): Promise<string>;
  now(): Date;
}

/** The threshold an acceptance names, which the person confirms from the node file's suggestion; required, so it is never taken unseen. */
function thresholdOf(body: unknown): number {
  const threshold = (body as Partial<NodeAdmissionBody> | null)?.threshold;
  if (threshold === undefined) throw new RequestError(400, "an admission names the threshold the node is admitted at");
  return validPriority(threshold, "the threshold");
}

function answerOf(body: unknown): NodeAdmissionBody["answer"] {
  const answer = (body as Partial<NodeAdmissionBody> | null)?.answer;
  if (answer !== "accept" && answer !== "refuse") throw new RequestError(400, "the answer is accept or refuse");
  return answer;
}

/**
 * The layout with the node admitted at the threshold the person confirmed: its device entry (found by its Syncthing ID, else added under
 * the node's name) and its node entry, `apply = false` written outright.
 * @implNote Admission is the commit that lets every other node share with it, so it is made before any share; it is never a path to `apply`,
 * which only its own confirmed switch turns on. A device name the layout already gives another ID is refused rather than overwritten. A
 * listed entry's `device` is repointed to the entry its Syncthing ID resolves to, whatever it named before, an empty one included.
 */
export function admitted(text: string, info: LocalNodeInfo, deviceId: string, threshold: number): string {
  const layout = parseLayout(text);
  if (layout.nodes.find((node) => node.id === info.nodeId)?.admitted) throw new RequestError(409, `${info.name} is already admitted`);
  const known = layout.devices.find((device) => device.id === deviceId);
  if (!known && layout.devices.some((device) => device.name === info.name)) throw new RequestError(409, `the layout has a device ${info.name} with another Syncthing ID; give the node another name or fix the layout by hand`);
  const withDevice = known ? text : upsertDevice(text, info.name, deviceId, info.root);
  const entry = layout.nodes.find((node) => node.id === info.nodeId);
  const device = known?.name ?? info.name;
  const change = { admitted: true, apply: false, threshold, refused: null, device };
  return entry ? editNodePolicy(withDevice, info.nodeId, change) : editNodePolicy(withDevice, info.nodeId, change, { name: info.name, device });
}

/** The layout with the refusal recorded on the node's entry, which keeps it off Requests until it is taken back in the layout. */
export function refused(text: string, info: LocalNodeInfo, at: Date): string {
  const entry = parseLayout(text).nodes.find((node) => node.id === info.nodeId);
  if (entry?.admitted) throw new RequestError(409, `${info.name} is already admitted`);
  return editNodePolicy(text, info.nodeId, { admitted: false, refused: at.toISOString() }, entry ? undefined : { name: info.name, device: "" });
}

const liveSources: AdmissionSources = {
  repository: setupRepoDirectory,
  findNode: async (nodeId) => (await findLocalNode(nodeId)) ?? joinedNodeInfos(new Date()).find((info) => info.nodeId === nodeId) ?? null,
  deviceId: async (info) => {
    if (info.source === "joined") {
      const deviceId = joinedDeviceIdOf(info.nodeId);
      if (!deviceId) throw new RequestError(409, `${info.name} has not reported lately, so its device ID is not known here`);
      return deviceId;
    }
    if (!info.instance) throw new RequestError(503, `${info.name}'s Syncthing is not answering, so its device ID cannot be read`);
    return callSyncthing(info.instance, (client) => client.myId());
  },
  now: () => new Date(),
};

/** Accepting commits `admitted = true` for the node, refusing records the refusal; both through the setup repo, from the node's own host. */
export function nodeAdmissionRoutes(sources: AdmissionSources = liveSources): AnyRoute[] {
  return [
    {
      method: "PUT",
      pattern: /^\/api\/nodes\/([^/]+)\/admission$/,
      write: async ({ request, response, params: [nodeSegment] }) => {
        const body = await readBody(request);
        const answer = answerOf(body);
        const base = requireBase(body as { base?: unknown });
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const info = await sources.findNode(nodeId);
        if (!info) throw new RequestError(404, `no node ${nodeId} on this host; it is admitted from the host it is attached to`);
        await layoutTextOf(sources.repository);
        const threshold = answer === "accept" ? thresholdOf(body) : 0;
        const deviceId = answer === "accept" ? await sources.deviceId(info) : "";
        const edit = (text: string) =>
          checkedLayout(answer === "accept" ? admitted(text, info, deviceId, threshold) : refused(text, info, sources.now()), (layout) => layout.nodes.find((node) => node.id === nodeId)?.admitted === (answer === "accept"), `${info.name} ${answer === "accept" ? "admitted" : "refused"}`);
        const words = answer === "accept" ? `admit ${info.name} to the layered sync` : `refuse ${info.name}'s admission`;
        const saved = await pullAfterConflict(sources.repository, saveLayout(edit, `feat(layout): ${words}`, base, layoutVersion, sources.repository));
        sendJson(response, 200, { saved });
        return saved.committed ? { nodeId, nodeName: info.name, folderId: null, text: `${info.name}: ${answer === "accept" ? "admitted to the layered sync" : "admission refused"}; ${saved.message}` } : { nothingWritten: true };
      },
    },
  ];
}
