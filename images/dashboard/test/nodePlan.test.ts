import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { type NodePlan, type PlannedFolder, clusterVersionsDays, handoffIgnoreLines, nodePlan } from "../src/nodePlan.js";
import { parseLayout } from "../src/setupRepo.js";

const fixtures = new URL("../../test/fixtures/layout/", import.meta.url);

const layoutText = `
[devices.pc]
id   = "PC-ID"
root = 'F:\\'

[devices.pc.paths]
Desktop = 'C:\\Users\\someone\\Desktop'

[devices.laptop]
id   = "LAPTOP-ID"
root = "/home/someone"

[devices.later]
id     = "LATER-ID"
joined = false

[devices.array]
id   = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"

[folders.Documents]
priority = 80
ignore   = ["/desktop.ini"]

[folders."Documents/GitHub"]
priority      = 90
versions_days = 30
ignore        = ["(?d)node_modules"]

[folders."Documents/GitHub/scratch"]
priority = 0

[folders.Desktop]
priority = 80

[folders.Videos]
priority = 30

[folders.Music]
priority = 50

[nodes.a001]
name      = "pc-data"
device    = "pc"
threshold = 50
admitted  = true

[nodes.a002]
name      = "laptop-data"
device    = "laptop"
threshold = 80
assigned  = ["Music"]
admitted  = true

[nodes.a002.pins]
Videos = 85

[nodes.a003]
name      = "later-data"
device    = "later"
threshold = 10
admitted  = true

[nodes.a004]
name      = "stranger"
device    = "laptop"
threshold = 10

[nodes.c1c1]
name      = "private-array"
device    = "array"
threshold = 0
admitted  = true
enabled   = false
`;

const layout = parseLayout(layoutText);

function planOf(nodeId: string, local: string[] = []): NodePlan {
  const plan = nodePlan(layout, nodeId, new Set(local));
  assert.ok(plan, `a plan for ${nodeId}`);
  return plan;
}

function folder(plan: NodePlan, id: string): PlannedFolder {
  const found = plan.folders.find((entry) => entry.id === id);
  assert.ok(found, `${id} in the plan of ${plan.nodeId}`);
  return found;
}

describe("a node's plan", () => {
  it("is send-receive at or above the threshold, with the folder's versions", () => {
    const music = folder(planOf("a001"), "music");

    assert.equal(music.type, "sendreceive");
    assert.equal(music.keptBy, "threshold");
    assert.equal(music.handsOff, false);
    assert.deepEqual(music.versioning, { type: "staggered", maxAgeDays: 365 });
    assert.equal(folder(planOf("a001"), "documents-github").versioning?.maxAgeDays, 30);
  });

  it("is send-only below the threshold while the node holds items there, without versions", () => {
    const videos = folder(planOf("a001", ["Videos"]), "videos");

    assert.equal(videos.type, "sendonly");
    assert.equal(videos.keptBy, null);
    assert.equal(videos.handsOff, true);
    assert.equal(videos.versioning, null);
  });

  it("does not share a folder below the threshold that the node holds nothing in", () => {
    const plan = planOf("a001");

    assert.equal(plan.folders.some((entry) => entry.id === "videos"), false);
    assert.deepEqual(plan.notShared, ["Videos"]);
  });

  it("keeps an assigned folder whatever the threshold", () => {
    const music = folder(planOf("a002"), "music");

    assert.equal(music.type, "sendreceive");
    assert.equal(music.keptBy, "assigned");
  });

  it("raises a pinned folder on its node only", () => {
    const pinned = folder(planOf("a002"), "videos");

    assert.equal(pinned.type, "sendreceive");
    assert.equal(pinned.keptBy, "pin");
    assert.equal(pinned.priority, 85);
    assert.equal(planOf("a001").notShared.includes("Videos"), true);
    assert.equal(folder(planOf("a001", ["Videos"]), "videos").priority, 30);
  });

  it("ignores each child entry in its parent, after the hand-off lines and before the folder's own", () => {
    assert.deepEqual(folder(planOf("a001"), "documents").ignores, [...handoffIgnoreLines, "/GitHub", "/desktop.ini"]);
    assert.deepEqual(folder(planOf("a001"), "documents-github").ignores, [...handoffIgnoreLines, "/scratch", "(?d)node_modules"]);
  });

  it("places a folder under the node's root, or at the device's own path for it", () => {
    assert.equal(folder(planOf("a001"), "documents-github").path, "F:\\Documents\\GitHub");
    assert.equal(folder(planOf("a001"), "desktop").path, "C:\\Users\\someone\\Desktop");
    assert.equal(folder(planOf("a002"), "documents-github").path, "/home/someone/Documents/GitHub");
  });

  it("shares a folder with every admitted, joined node that has it, and itself", () => {
    assert.deepEqual(folder(planOf("a001"), "music").devices, ["ARRAY-ID", "LAPTOP-ID", "PC-ID"]);
    assert.deepEqual(folder(planOf("a003"), "music").devices, ["ARRAY-ID", "LAPTOP-ID", "LATER-ID", "PC-ID"]);
  });

  it("sends a priority 0 entry to the cluster under Nodes/<name>/, send-only and kept on the node", () => {
    const scratch = folder(planOf("a001", ["Documents/GitHub/scratch"]), "a001-documents-github-scratch");

    assert.equal(scratch.type, "sendonly");
    assert.equal(scratch.local, true);
    assert.equal(scratch.handsOff, false);
    assert.equal(scratch.path, "F:\\Documents\\GitHub\\scratch");
    assert.deepEqual(scratch.devices, ["ARRAY-ID", "PC-ID"]);
    assert.equal(planOf("a001").folders.some((entry) => entry.local), false);
  });

  it("gives the cluster each node's priority 0 entries apart, send-receive with its versions", () => {
    const fromPc = folder(planOf("c1c1"), "a001-documents-github-scratch");

    assert.equal(fromPc.label, "Nodes/pc-data/Documents/GitHub/scratch");
    assert.equal(fromPc.path, "/mnt/storage/pool/Nodes/pc-data/Documents/GitHub/scratch");
    assert.equal(fromPc.type, "sendreceive");
    assert.deepEqual(fromPc.versioning, { type: "staggered", maxAgeDays: clusterVersionsDays });
    assert.deepEqual(fromPc.devices, ["ARRAY-ID", "PC-ID"]);
    assert.equal(planOf("c1c1").folders.some((entry) => entry.id === "documents-github-scratch"), false);
  });

  it("keeps everything send-receive on the cluster, with 90 days of staggered versions", () => {
    const plan = planOf("c1c1");

    for (const id of ["documents", "documents-github", "desktop", "videos", "music"]) {
      assert.equal(folder(plan, id).type, "sendreceive", id);
      assert.deepEqual(folder(plan, id).versioning, { type: "staggered", maxAgeDays: 90 }, id);
    }
  });

  it("pauses every folder of a node that is not enabled", () => {
    assert.equal(planOf("c1c1").folders.every((entry) => entry.paused), true);
    assert.equal(planOf("a001").folders.some((entry) => entry.paused), false);
  });

  it("shares nothing for a node that is not admitted, and is null for an unknown node", () => {
    assert.deepEqual(planOf("a004").folders, []);
    assert.equal(planOf("a004").admitted, false);
    assert.equal(nodePlan(layout, "ffff", new Set()), null);
  });

  it("raises a pinned parent's children above 0 to the pin, and leaves its priority 0 children local", () => {
    const pinnedParent = parseLayout(`${layoutText}\n[nodes.a006]\nname = "pinner"\ndevice = "laptop"\nthreshold = 92\nadmitted = true\n[nodes.a006.pins]\nDocuments = 95\n`);
    const plan = nodePlan(pinnedParent, "a006", new Set(["Documents/GitHub/scratch"]));
    assert.ok(plan);

    assert.equal(folder(plan, "documents").keptBy, "pin");
    assert.equal(folder(plan, "documents-github").keptBy, "pin");
    assert.equal(folder(plan, "documents-github").priority, 95);
    assert.equal(folder(plan, "documents-github").type, "sendreceive");
    assert.equal(folder(plan, "a006-documents-github-scratch").local, true);
    assert.deepEqual(plan.unplaced, []);
  });

  it("plans nothing for a node with a blocking layout problem, and leaves it out of every other plan", () => {
    const broken = parseLayout(layoutText.replace('name      = "laptop-data"', 'name      = "Laptop Data"'));
    const laptop = nodePlan(broken, "a002", new Set(["Music"]));

    assert.deepEqual(laptop?.folders, []);
    assert.deepEqual(laptop?.problems, ["name 'Laptop Data' does not match [a-z0-9-]"]);
    assert.deepEqual(nodePlan(broken, "a001", new Set())?.folders.find((entry) => entry.id === "music")?.devices, ["ARRAY-ID", "PC-ID"]);
  });

  it("takes no cluster while two nodes are on archive devices", () => {
    const twoArchives = parseLayout(`${layoutText}\n[devices.second]\nid = "SECOND-ID"\nrole = "archive"\n[nodes.c2c2]\nname = "second"\ndevice = "second"\nadmitted = true\n`);

    assert.deepEqual(nodePlan(twoArchives, "c1c1", new Set())?.folders, []);
    assert.equal(nodePlan(twoArchives, "a001", new Set(["Documents/GitHub/scratch"]))?.folders.find((entry) => entry.local)?.devices.join(), "PC-ID");
  });

  it("names the pins and assigned paths that have no folder of their own", () => {
    const pinned = parseLayout(`${layoutText}\n[nodes.a005]\nname = "laptop-two"\ndevice = "laptop"\nadmitted = true\nassigned = ["Videos/Holiday"]\n[nodes.a005.pins]\n"Music/Live" = 90\n`);

    assert.deepEqual(nodePlan(pinned, "a005", new Set())?.unplaced, ["Music/Live", "Videos/Holiday"]);
  });
});

interface DriveSyncFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  ignore_delete: boolean;
  versions_days: number | null;
  ignore: string[];
  devices: string[];
}

type GoldenDevice = "pc" | "p53" | "array";
type GoldenPlans = Record<"today" | "joined", Record<GoldenDevice, DriveSyncFolder[]>>;

/** Today's layout as both tools see it: pc and p53 at a threshold between archive (30) and synced (80), the array keeping everything. */
function goldenNodes(pcThreshold: number): string {
  return `
[nodes.a001]
name      = "pc-data"
device    = "pc"
threshold = ${pcThreshold}
admitted  = true

[nodes.a053]
name      = "p53-data"
device    = "p53"
threshold = 50
admitted  = true

[nodes.c1c1]
name      = "private-array"
device    = "array"
threshold = 0
admitted  = true
`;
}

/** The variant golden.py makes: p53 and the array joined. */
function joinedText(text: string): string {
  return text.replaceAll("joined = false", "joined = true").replaceAll("joined     = false", "joined     = true");
}

/** The fields both tools plan alike everywhere; the array's type, versions and `ignoreDelete` are asserted on their own. */
function shared(folder: { id: string; label: string; path: string; ignore: string[]; devices: string[] }) {
  return { id: folder.id, label: folder.label, path: folder.path, ignore: folder.ignore, devices: folder.devices };
}

function byId<Entry extends { id: string }>(entries: Entry[]): Entry[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

function sharedFolders(plan: NodePlan): PlannedFolder[] {
  return byId(plan.folders.filter((entry) => !entry.local));
}

/** Every field of a planned folder; the reconciler has no ignoreDelete to set, so a keeper applies a deletion into its versions. */
const plannedFolderFields = ["devices", "handsOff", "id", "ignores", "keptBy", "label", "local", "path", "paused", "priority", "relativePath", "type", "versioning"];

function asDriveSync(folder: PlannedFolder): DriveSyncFolder {
  return {
    id: folder.id,
    label: folder.label,
    path: folder.path,
    type: folder.type,
    ignore_delete: false,
    versions_days: folder.versioning?.maxAgeDays ?? null,
    ignore: folder.ignores.filter((line) => !handoffIgnoreLines.includes(line)),
    devices: folder.devices,
  };
}

describe("the golden test against drive-sync", async () => {
  const text = await readFile(new URL("drive-sync.toml", fixtures), "utf8");
  const golden = JSON.parse(await readFile(new URL("drive-sync-plans.json", fixtures), "utf8")) as GoldenPlans;
  const variants = { today: text, joined: joinedText(text) };

  for (const [variant, variantText] of Object.entries(variants) as [keyof GoldenPlans, string][]) {
    for (const pcThreshold of [31, 50, 80]) {
      const layout = parseLayout(`${variantText}\n${goldenNodes(pcThreshold)}`);
      const everyFolder = new Set(layout.folders.map((entry) => entry.relativePath));
      const planFor = (nodeId: string) => nodePlan(layout, nodeId, everyFolder) as NodePlan;

      it(`plans pc and p53 as drive-sync does (${variant}, pc at ${pcThreshold})`, () => {
        assert.deepEqual(sharedFolders(planFor("a001")).map(asDriveSync), byId(golden[variant].pc));
        assert.deepEqual(sharedFolders(planFor("a053")).map(asDriveSync), byId(golden[variant].p53));
      });

      it(`plans the array's folders, paths, ignores and shares as drive-sync does (${variant}, pc at ${pcThreshold})`, () => {
        const array = sharedFolders(planFor("c1c1"));

        assert.deepEqual(
          array.map((folder) => shared({ ...folder, ignore: folder.ignores.filter((line) => !handoffIgnoreLines.includes(line)) })),
          byId(golden[variant].array).map(shared),
        );
      });

      it(`makes every array folder send-receive with 90 days and nothing that keeps deletions (${variant}, pc at ${pcThreshold})`, () => {
        const array = new Map(sharedFolders(planFor("c1c1")).map((folder) => [folder.id, folder]));

        for (const theirs of golden[variant].array) {
          const ours = array.get(theirs.id);
          assert.ok(ours, theirs.id);
          assert.equal(ours.type, "sendreceive", theirs.id);
          assert.deepEqual(ours.versioning, { type: "staggered", maxAgeDays: clusterVersionsDays }, theirs.id);
          assert.deepEqual(Object.keys(ours).sort(), plannedFolderFields, `${theirs.id}: the reconciler reads these fields, none of which keeps deletions`);
        }
        assert.ok(golden[variant].array.some((theirs) => theirs.type === "receiveonly" && theirs.ignore_delete), "drive-sync made the archive receive-only with ignoreDelete");
      });
    }
  }

  it("adds only the priority 0 entries drive-sync leaves out, for the cluster under Nodes/", () => {
    const layout = parseLayout(`${text}\n${goldenNodes(50)}`);
    const everyFolder = new Set(layout.folders.map((entry) => entry.relativePath));

    assert.deepEqual(nodePlan(layout, "a001", everyFolder)?.folders.filter((entry) => entry.local).map((entry) => entry.id), ["a001-documents-virtual-machines", "a001-sites"]);
    assert.deepEqual(nodePlan(layout, "c1c1", everyFolder)?.folders.filter((entry) => entry.local).map((entry) => entry.id), ["a001-documents-virtual-machines", "a001-sites"]);
  });
});
