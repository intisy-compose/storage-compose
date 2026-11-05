import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FolderCopy, FolderSettings } from "../src/api/types.js";
import { isHandoffFolder, withHandoffFlags } from "../src/handoffFolders.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { parseLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";
import { copyCondition } from "../ui/src/folderCondition.js";
import { localChangesActionOf } from "../ui/src/localChangesForm.js";

const layout = parseLayout(`[devices.pc]
id = "PC-ID"
root = "/data"
joined = true

[devices.array]
id = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"
joined = true

[devices.p53]
id = "P53-ID"
root = "/data"
joined = true

[folders.Documents]
priority = 80

[folders.Videos]
priority = 30

[folders.Music]
priority = 30

[folders.Pictures]
priority = 30

[nodes.a1b2]
name = "pc"
device = "pc"
threshold = 50
admitted = true
assigned = ["Music"]

[nodes.a1b2.pins]
"Pictures" = 60

[nodes.5784]
name = "private-array"
device = "array"
admitted = true

[nodes.c3d4]
name = "p53"
device = "p53"
threshold = 20
admitted = true
`);

function copyOf(id: string, overrides: Partial<FolderCopy> = {}): FolderCopy {
  return { id, label: id, nodeId: "a1b2", nodeName: "pc", host: "storage", local: true, paused: false, state: "idle", completion: 100, errors: 0, type: "sendonly", ...overrides } as FolderCopy;
}

describe("Override changes on a hand-off folder", () => {
  it("each copy of this host knows from its node's plan whether it is a hand-off folder", () => {
    const flagged = withHandoffFlags([copyOf("videos"), copyOf("documents", { type: "sendreceive" })], layout);
    assert.deepEqual(flagged.map((copy) => [copy.id, copy.handoff]), [["videos", true], ["documents", false]]);
    assert.deepEqual(withHandoffFlags([copyOf("videos")], null).map((copy) => copy.handoff), [false]);
  });

  it("the folder form never offers it on one, and still offers it on a plain send-only folder", () => {
    const settings = { type: "sendonly" } as FolderSettings;
    assert.equal(localChangesActionOf(settings, true), null);
    assert.equal(localChangesActionOf(settings, false), "override");
    assert.equal(localChangesActionOf({ type: "receiveonly" } as FolderSettings, true), "revert");
  });

  it("the server knows one by its ignore lines, by the layout, and while its ignores cannot be read", async () => {
    const instance = (ignore: string[] | null): LocalInstance => {
      const client = {
        request: async () => {
          if (ignore === null) throw new Error("the include file is missing");
          return { ignore };
        },
        folders: async () => [{ id: "videos" }, { id: "documents" }],
      } as unknown as SyncthingClient;
      return { kind: "local", nodeId: "a1b2", name: "pc", client, root: "/data", os: "linux", threshold: 50, source: "registry" };
    };
    assert.equal(await isHandoffFolder(instance(["// layered sync begin", "#include .stignore-handoff"]), "documents", null), true);
    assert.equal(await isHandoffFolder(instance([]), "videos", layout), true);
    assert.equal(await isHandoffFolder(instance([]), "documents", layout), false);
    assert.equal(await isHandoffFolder(instance([]), "videos", null), false);
    assert.equal(await isHandoffFolder(instance(null), "documents", layout), true);
  });

  it("an idle hand-off folder one item short is no fault", () => {
    assert.deepEqual(copyCondition(copyOf("videos", { handoff: true, completion: 52 })), { rank: 0, tone: "ok", label: "sends only, hands off" });
    assert.notEqual(copyCondition(copyOf("videos", { completion: 52 })).tone, "ok");
    assert.equal(copyCondition(copyOf("videos", { handoff: true, errors: 2 })).tone, "bad");
  });
});
