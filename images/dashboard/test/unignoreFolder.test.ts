import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnconfirmedWrite } from "../src/http.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { unignoreFolder } from "../src/routes/ignoredLists.js";
import { type SyncthingClient, SyncthingUnavailable } from "../src/syncthing.js";

const offeredBy = "OFFERER-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";

type IgnoredFolder = { id: string; label: string; time: string };

const folder = (id: string): IgnoredFolder => ({ id, label: id, time: "2026-10-27T10:00:00Z" });

/**
 * A node whose offering device's ignored folders read as `reads` gives them, one answer per read and the last one after, and as `listed`
 * in its whole configuration until then; every PATCH kept. With `losePatchAnswer` the PATCH is applied and the node then stops answering.
 */
function nodeWith(reads: IgnoredFolder[][], listed = reads[0], losePatchAnswer = false) {
  const patches: unknown[] = [];
  let deviceReads = 0;
  let current = listed;
  let answers = true;
  const client = {
    endpoint: { url: "http://127.0.0.1:9999", apiKey: "key" },
    request: async (method: string, path: string, body?: unknown) => {
      if (!answers) throw new SyncthingUnavailable(`${method} ${path}: connection refused`);
      if (method === "GET" && path === "/config") return { devices: [{ deviceID: offeredBy, name: "offerer", ignoredFolders: current }], remoteIgnoredDevices: [] };
      if (method === "GET" && path === `/config/devices/${offeredBy}`) {
        current = patches.length ? current : reads[Math.min(deviceReads, reads.length - 1)];
        deviceReads++;
        return { deviceID: offeredBy, ignoredFolders: current };
      }
      if (method === "PATCH" && path === `/config/devices/${offeredBy}`) {
        patches.push(body);
        current = (body as { ignoredFolders: IgnoredFolder[] }).ignoredFolders;
        if (losePatchAnswer) {
          answers = false;
          throw new SyncthingUnavailable(`${method} ${path}: connection reset`);
        }
        return null;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as SyncthingClient;
  const instance: LocalInstance = { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client, root: "/data", os: "linux", threshold: 0, source: "registry" };
  return { instance, patches };
}

describe("un-ignoring a folder whose ignored list changes meanwhile", () => {
  it("starts once more from the changed list and keeps what was added", async () => {
    const { instance, patches } = nodeWith([[folder("a"), folder("b")], [folder("a"), folder("b"), folder("c")]]);

    const done = await unignoreFolder(instance, "a", offeredBy, []);

    assert.deepEqual(patches, [{ ignoredFolders: [folder("b"), folder("c")] }]);
    assert.deepEqual(done.lists.folders.map((entry) => entry.folderId), ["b", "c"]);
  });

  it("answers 409 with nothing written when the list changes on both tries", async () => {
    const { instance, patches } = nodeWith([[folder("a")], [folder("a"), folder("b")], [folder("a"), folder("b"), folder("c")], [folder("a"), folder("d")]]);

    await assert.rejects(unignoreFolder(instance, "a", offeredBy, []), { status: 409, message: /changed twice while a was being un-ignored; nothing was written, try again$/ });
    assert.deepEqual(patches, []);
  });

  it("answers as done, writing nothing, when the folder was un-ignored elsewhere meanwhile", async () => {
    const { instance, patches } = nodeWith([[folder("b")]], [folder("a"), folder("b")]);

    const done = await unignoreFolder(instance, "a", offeredBy, []);

    assert.deepEqual(patches, []);
    assert.deepEqual(done.lists.folders.map((entry) => entry.folderId), ["b"]);
    assert.match(done.note.text, /un-ignored folder a offered by offerer/);
  });

  it("a write whose answer is lost and whose effect cannot be read back may have been saved", async () => {
    const { instance, patches } = nodeWith([[folder("a"), folder("b")]], undefined, true);

    await assert.rejects(unignoreFolder(instance, "a", offeredBy, []), (error: unknown) => error instanceof UnconfirmedWrite);
    assert.deepEqual(patches, [{ ignoredFolders: [folder("b")] }]);
  });
});
