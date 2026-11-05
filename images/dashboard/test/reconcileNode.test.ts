import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalInstance } from "../src/instanceResolver.js";
import { type NodePlan, handoffIgnoreLines, nodePlan } from "../src/nodePlan.js";
import { type HandoffFiles, type ReconcileOptions, carriedLayoutPaths, ignoreBlockBegin, ignoreBlockEnd, layoutDeviceIds, managedIgnoreLines, reconcileNode } from "../src/reconcileNode.js";
import { saveIgnores } from "../src/routes/folderIgnores.js";
import { parseLayout } from "../src/setupRepo.js";
import { type FakeSyncthing, type SyncthingObject, clientOf, folderOf, keeperId, onPlan, ownId, phoneId, versioningOf } from "./fakeFolderSyncthing.js";

const layoutText = `
[devices.laptop]
id   = "LAPTOP-ID"
root = "/data"

[devices.keeper]
id   = "KEEPER-ID"
root = "/keep"

[folders.Documents]
priority = 80

[folders."Documents/Old"]
priority = 30

[folders.Videos]
priority = 30

[nodes.a001]
name      = "laptop-data"
device    = "laptop"
threshold = 50
admitted  = true

[nodes.a002]
name      = "keeper-data"
device    = "keeper"
threshold = 0
admitted  = true
`;

const layout = parseLayout(layoutText);

function instanceOf(syncthing: FakeSyncthing, source: LocalInstance["source"] = "registry"): LocalInstance {
  return { kind: "local", nodeId: "a001", name: "laptop-data", client: clientOf(syncthing), root: "/data", os: "linux", threshold: 50, source };
}

function planOf(configured: string[], threshold = 50): NodePlan {
  const at = parseLayout(layoutText.replace("threshold = 50", `threshold = ${threshold}`));
  const plan = nodePlan(at, "a001", carriedLayoutPaths(at, "a001", new Set(configured)));
  assert.ok(plan);
  return plan;
}

const presentHandoffFiles: HandoffFiles = { ensure: async () => null };

function options(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return { apply: true, layout, handoffFiles: presentHandoffFiles, readBackDelaysMs: [], ...overrides };
}

const configured = ["documents", "documents-old"];

describe("reconciling a node with its plan", () => {
  it("finds nothing to change on a node that has its plan", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(result.folders, []);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("in report mode writes nothing and returns the diff", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents-old").type = "sendreceive";
    folderOf(syncthing, "documents").versioning = versioningOf(null);
    syncthing.ignores.set("documents", []);
    let ensured = 0;

    const result = await reconcileNode(instanceOf(syncthing), plan, options({ apply: false, handoffFiles: { ensure: async () => (++ensured, null) } }));

    assert.equal(result.mode, "report");
    assert.deepEqual(syncthing.writes(), []);
    assert.equal(ensured, 0);
    const byFolder = Object.fromEntries(result.folders.map((folder) => [folder.folderId, folder.changes.map((change) => change.field)]));
    assert.deepEqual(byFolder, { documents: ["ignores", "versioning"], "documents-old": ["type"] });
    assert.ok(result.folders.every((folder) => folder.written.length === 0));
  });

  it("sends each change as a request of its field alone", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    const documents = folderOf(syncthing, "documents");
    documents.versioning = versioningOf(30);
    documents.devices = [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }];
    folderOf(syncthing, "documents-old").type = "sendreceive";

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    const patches = syncthing.writes().filter((sent) => sent.method === "PATCH");
    assert.ok(patches.length >= 3);
    for (const patch of patches) assert.equal(Object.keys(patch.body as object).length, 1, JSON.stringify(patch.body));
    assert.deepEqual(syncthing.writes().map((sent) => `${sent.path} ${Object.keys(sent.body as object)[0]}`).sort(), [
      "/config/folders/documents devices",
      "/config/folders/documents versioning",
      "/config/folders/documents-old type",
    ]);
    assert.deepEqual((folderOf(syncthing, "documents").versioning as SyncthingObject).params, { maxAge: String(365 * 86400) });
    assert.deepEqual((folderOf(syncthing, "documents").devices as SyncthingObject[]).map((entry) => entry.deviceID).sort(), [keeperId, ownId]);
    assert.deepEqual(result.folders.map((folder) => folder.written).flat().sort(), ["sharing", "type", "versioning"]);
  });

  it("keeps the other fields of a folder's versioning as Syncthing has them", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").versioning = { ...versioningOf(null), cleanupIntervalS: 7200, fsPath: "/elsewhere" };

    await reconcileNode(instanceOf(syncthing), plan, options());

    const versioning = folderOf(syncthing, "documents").versioning as SyncthingObject;
    assert.equal(versioning.type, "staggered");
    assert.equal(versioning.cleanupIntervalS, 7200);
    assert.equal(versioning.fsPath, "/elsewhere");
  });

  it("makes a folder that goes below the threshold send-only before anything else is sent", async () => {
    const above = planOf(configured, 20);
    assert.equal(above.folders.find((folder) => folder.id === "documents-old")?.type, "sendreceive");
    const syncthing = onPlan(above);
    const below = planOf(configured);

    await reconcileNode(instanceOf(syncthing), below, options());

    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
    const first = syncthing.writes().find((sent) => sent.path === "/config/folders/documents-old");
    assert.deepEqual(first?.body, { type: "sendonly" });
    assert.equal(syncthing.writes().filter((sent) => sent.path.includes("documents-old"))[0], first);
  });

  it("holds a folder turning send-receive until the space rule, and writes its ignores and versioning", async () => {
    const below = planOf(configured);
    const syncthing = onPlan(below);
    const above = planOf(configured, 20);
    syncthing.ignores.set("documents-old", []);

    const result = await reconcileNode(instanceOf(syncthing), above, options());

    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
    const old = result.folders.find((folder) => folder.folderId === "documents-old");
    const type = old?.changes.find((change) => change.field === "type");
    assert.equal(type?.written, false);
    assert.equal(type?.held, "turning send-receive waits for the space rule");
    assert.deepEqual(old?.written.sort(), ["ignores", "versioning"]);
  });

  it("holds the type-up in report mode too, and while the ignores are held", async () => {
    const syncthing = onPlan(planOf(configured));
    syncthing.ignores.set("documents-old", []);
    const above = planOf(configured, 20);

    const reported = await reconcileNode(instanceOf(syncthing), above, options({ apply: false }));
    const applied = await reconcileNode(instanceOf(syncthing), above, options({ handoffFiles: { ensure: async () => "not mounted" } }));

    for (const result of [reported, applied]) {
      const type = result.folders.find((folder) => folder.folderId === "documents-old")?.changes.find((change) => change.field === "type");
      assert.equal(type?.held, "turning send-receive waits for the space rule");
    }
    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
  });

  for (const type of ["receiveonly", "receiveencrypted"]) {
    it(`never changes a ${type} folder's type`, async () => {
      const plan = planOf(configured);
      const syncthing = onPlan(plan);
      folderOf(syncthing, "documents").type = type;

      const result = await reconcileNode(instanceOf(syncthing), plan, options());

      assert.equal(folderOf(syncthing, "documents").type, type);
      const change = result.folders.find((folder) => folder.folderId === "documents")?.changes.find((entry) => entry.field === "type");
      assert.match(change?.held ?? "", /^type receive (only|encrypted) is not changed here$/);
      assert.ok(!syncthing.writes().some((sent) => (sent.body as SyncthingObject | undefined)?.type !== undefined));
    });
  }

  it("never makes the cluster send-only", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents-old").type = "sendreceive";

    const result = await reconcileNode(instanceOf(syncthing), { ...plan, cluster: true }, options());

    assert.equal(folderOf(syncthing, "documents-old").type, "sendreceive");
    assert.equal(result.folders[0]?.changes.find((change) => change.field === "type")?.held, "the cluster is never made send-only");
  });

  it("shares only with devices the node knows and stops sharing only with layout devices", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.devices = [{ deviceID: ownId }, { deviceID: phoneId }];
    folderOf(syncthing, "documents").devices = [{ deviceID: ownId }, { deviceID: phoneId }];

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(result.unknownDevices, [keeperId]);
    assert.deepEqual(syncthing.writes(), []);
    assert.deepEqual((folderOf(syncthing, "documents").devices as SyncthingObject[]).map((entry) => entry.deviceID), [ownId, phoneId]);
  });

  it("stops sharing with a layout device the plan does not share with", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    const unshared = { ...plan, folders: plan.folders.map((folder) => (folder.id === "documents" ? { ...folder, devices: [ownId] } : folder)) };

    await reconcileNode(instanceOf(syncthing), unshared, options());

    assert.deepEqual((folderOf(syncthing, "documents").devices as SyncthingObject[]).map((entry) => entry.deviceID), [ownId]);
  });

  it("puts the plan's lines in a block above the node's own lines, which stay in order", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.ignores.set("documents", ["/local-only", "!/Old", "(?d).DS_Store"]);

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    const planned = plan.folders.find((folder) => folder.id === "documents")?.ignores ?? [];
    assert.deepEqual(syncthing.ignores.get("documents"), [ignoreBlockBegin, ...planned, ignoreBlockEnd, "/local-only", "!/Old", "(?d).DS_Store"]);
    assert.deepEqual(planned.slice(0, 2), handoffIgnoreLines);
    assert.ok(planned.includes("/Old"));
    assert.deepEqual(result.nodeOnlyIgnores, [{ folderId: "documents", label: "Documents", lines: ["/local-only", "!/Old", "(?d).DS_Store"] }]);
  });

  it("changes only lines inside its block and never reports the node's own lines as drift", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    const planned = plan.folders.find((folder) => folder.id === "documents")?.ignores ?? [];
    syncthing.ignores.set("documents", ["/before", ...managedIgnoreLines([...planned, "/stale"]), "/after"]);

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(syncthing.ignores.get("documents"), [...managedIgnoreLines(planned), "/before", "/after"]);
    assert.equal(result.folders.find((folder) => folder.folderId === "documents")?.changes[0]?.text, "ignore patterns: remove /stale");

    syncthing.sent = [];
    syncthing.ignores.set("documents", [...managedIgnoreLines(planned), "/after", "/more"]);
    const again = await reconcileNode(instanceOf(syncthing), plan, options());
    assert.deepEqual(again.folders, []);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("keeps a line saved through the ignores route outside the block on the next pull", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    const opened = [...(syncthing.ignores.get("documents") ?? [])];
    await saveIgnores(instanceOf(syncthing), "documents", { lines: [...opened, "/edited-by-hand"], opened }, []);

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(result.folders, []);
    assert.deepEqual(syncthing.ignores.get("documents"), [...opened, "/edited-by-hand"]);
  });

  it("creates an empty .stignore-handoff after the list is ignored and before the #include is written", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.ignores.set("documents", []);
    const seenAtEnsure: string[][] = [];
    const handoffFiles: HandoffFiles = {
      ensure: async (_instance, folder) => {
        seenAtEnsure.push([...(syncthing.ignores.get(folder.id) ?? [])]);
        return null;
      },
    };

    await reconcileNode(instanceOf(syncthing), plan, options({ handoffFiles }));

    assert.equal(seenAtEnsure.length, 1);
    assert.ok(!seenAtEnsure[0].includes(handoffIgnoreLines[0]), "no #include before the file exists");
    assert.ok(seenAtEnsure[0].includes(handoffIgnoreLines[1]), "the list is ignored before it is created");
    assert.deepEqual(syncthing.ignores.get("documents"), managedIgnoreLines(plan.folders.find((folder) => folder.id === "documents")?.ignores ?? []));
  });

  it("holds the #include while the hand-off list cannot be created, and writes the folder's other changes", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.ignores.set("documents", []);
    folderOf(syncthing, "documents").versioning = versioningOf(null);

    const result = await reconcileNode(instanceOf(syncthing), plan, options({ handoffFiles: { ensure: async () => "this host does not mount the node's files" } }));

    const lines = syncthing.ignores.get("documents") ?? [];
    assert.ok(!lines.includes(handoffIgnoreLines[0]));
    assert.ok(lines.includes(handoffIgnoreLines[1]));
    const documents = result.folders.find((folder) => folder.folderId === "documents");
    assert.match(documents?.changes.find((change) => change.field === "ignores")?.held ?? "", /\.stignore-handoff is not in place on laptop-data \(this host does not mount the node's files\)/);
    assert.deepEqual(documents?.written, ["versioning"]);
    assert.ok(lines.includes("/Old"), "the child entry is ignored while the include waits");
  });

  it("does not ask for the hand-off list when the #include is already in place", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.ignores.set("documents", managedIgnoreLines([...handoffIgnoreLines]));
    let ensured = 0;

    await reconcileNode(instanceOf(syncthing), plan, options({ handoffFiles: { ensure: async () => (++ensured, null) } }));

    assert.equal(ensured, 0);
  });

  it("never changes an array without the folder ID typed", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").versioning = versioningOf(null);
    folderOf(syncthing, "documents-old").type = "sendreceive";

    const result = await reconcileNode(instanceOf(syncthing, "array"), plan, options());

    assert.deepEqual(syncthing.writes(), []);
    for (const folder of result.folders) assert.match(folder.held ?? "", new RegExp(`type the folder ID ${folder.folderId}`));
  });

  it("changes an array's folder once its ID is typed, and only that folder", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").versioning = versioningOf(null);
    folderOf(syncthing, "documents-old").type = "sendreceive";

    await reconcileNode(instanceOf(syncthing, "array"), plan, options({ confirmations: { "documents-old": "documents-old", documents: "Documents" } }));

    assert.deepEqual(syncthing.writes().map((sent) => sent.path), ["/config/folders/documents-old"]);
  });

  it("reports planned folders the node does not have and never adds them", async () => {
    const plan = planOf([...configured, "videos"]);
    const syncthing = onPlan(plan);
    syncthing.folders = syncthing.folders.filter((folder) => folder.id !== "videos");

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(result.missing.map((folder) => folder.folderId), ["videos"]);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("reports a layout folder the node has but its plan leaves out, and never removes it", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.folders.push({ id: "videos", label: "Videos", path: "/data/Videos", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: versioningOf(null) });

    const result = await reconcileNode(instanceOf(syncthing), { ...plan, folders: plan.folders }, options());

    assert.deepEqual(result.unplanned, ["videos"]);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("enters each written change for Activity", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents-old").type = "sendreceive";
    const entered: string[] = [];

    await reconcileNode(instanceOf(syncthing), plan, options({ onWritten: (folderId, text) => entered.push(`${folderId}: ${text}`) }));

    assert.equal(entered.length, 1);
    assert.match(entered[0], /^documents-old: laptop-data: .*send and receive to send only/);
  });

  it("a node whose Syncthing does not answer is a 503 naming it", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    syncthing.answers = false;

    await assert.rejects(reconcileNode(instanceOf(syncthing), plan, options()), (error: Error & { status?: number }) => error.status === 503 && /laptop-data/.test(error.message));
  });
});

describe("never shortening or replacing a folder's versioning", () => {
  const cases: { name: string; documents: SyncthingObject; old?: SyncthingObject; held: string | null }[] = [
    { name: "a staggered one with a longer maxAge", documents: versioningOf(400), held: "would shorten how long versions are kept" },
    { name: "one that keeps versions forever (maxAge 0)", documents: versioningOf(0), held: "would shorten how long versions are kept" },
    { name: "a staggered one without a maxAge", documents: { ...versioningOf(null), type: "staggered" }, held: "would replace the folder's versioning" },
    { name: "another type", documents: { type: "simple", params: { keep: "5" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" }, held: "would replace the folder's versioning" },
  ];
  for (const entry of cases) {
    it(`holds ${entry.name}`, async () => {
      const plan = planOf(configured);
      const syncthing = onPlan(plan);
      folderOf(syncthing, "documents").versioning = structuredClone(entry.documents);

      const result = await reconcileNode(instanceOf(syncthing), plan, options());

      assert.deepEqual(folderOf(syncthing, "documents").versioning, entry.documents);
      assert.equal(result.folders[0]?.changes.find((change) => change.field === "versioning")?.held, entry.held);
      assert.deepEqual(syncthing.writes(), []);
    });
  }

  it("never clears the versioning of a folder its plan sends only", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents-old").versioning = versioningOf(365);

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(folderOf(syncthing, "documents-old").versioning, versioningOf(365));
    assert.equal(result.folders[0]?.changes[0]?.held, "would replace the folder's versioning");
  });

  it("raises a staggered maxAge the plan keeps longer", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").versioning = versioningOf(30);

    await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(folderOf(syncthing, "documents").versioning, versioningOf(365));
  });
});

describe("sharing a folder", () => {
  it("never shares with a node whose access is closed", async () => {
    const closed = parseLayout(layoutText.replace('name      = "keeper-data"', 'name      = "keeper-data"\naccess    = "closed"'));
    const plan = nodePlan(closed, "a001", carriedLayoutPaths(closed, "a001", new Set(configured)));
    assert.ok(plan);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").devices = [{ deviceID: ownId }];

    const result = await reconcileNode(instanceOf(syncthing), plan, options({ layout: closed }));

    assert.deepEqual((folderOf(syncthing, "documents").devices as SyncthingObject[]).map((entry) => entry.deviceID), [ownId]);
    const sharing = result.folders[0]?.changes.find((change) => change.field === "sharing");
    assert.match(sharing?.held ?? "", /access is closed, so nothing is shared with it until its encryption exists/);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("writes the device list over a fresh read, so a device shared meanwhile stays shared", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").devices = [{ deviceID: ownId }];
    let listed = false;
    syncthing.onRequest = (method, path) => {
      if (method === "GET" && path === "/config/folders") listed = true;
      else if (listed) {
        listed = false;
        (folderOf(syncthing, "documents").devices as SyncthingObject[]).push({ deviceID: phoneId });
      }
    };

    await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual((folderOf(syncthing, "documents").devices as SyncthingObject[]).map((entry) => entry.deviceID).sort(), [keeperId, ownId, phoneId].sort());
  });
});

describe("a folder whose writes fail", () => {
  it("is listed in failed while the other folders are reconciled, its drift still shown", async () => {
    const plan = planOf(configured);
    const syncthing = onPlan(plan);
    folderOf(syncthing, "documents").versioning = versioningOf(null);
    folderOf(syncthing, "documents-old").type = "sendreceive";
    syncthing.failing = { path: /^\/config\/folders\/documents$/, error: new Error("refused") };

    const result = await reconcileNode(instanceOf(syncthing), plan, options());

    assert.deepEqual(result.failed, ["Documents: refused"]);
    assert.equal(result.folders.find((folder) => folder.folderId === "documents")?.changes.length, 1);
    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
  });
});

describe("what a node carries", () => {
  it("counts a layout folder the node has, its own priority 0 folder included", () => {
    const zero = parseLayout(`${layoutText}\n[folders.Scratch]\npriority = 0\n`);

    const carried = carriedLayoutPaths(zero, "a001", new Set(["documents", "a001-scratch", "somethingelse"]));

    assert.deepEqual([...carried].sort(), ["Documents", "Scratch"]);
  });

  it("lists the layout's device IDs", () => {
    assert.deepEqual([...layoutDeviceIds(layout)].sort(), [keeperId, ownId]);
  });
});
