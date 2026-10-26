import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JoinDependencies, type JoinInstance, type JoinedDevice, JoinError, admittedFolders, handleJoin } from "../src/join.js";
import { parseLayout } from "../src/setupRepo.js";
import type { SyncthingDeviceConfig } from "../src/syncthing.js";
import type { WhoIs } from "../src/tailnet.js";

const p53Id = "P53AAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const otherId = "ZZZZZZZ-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const owner = "finn@example.com";

const layoutText = `
[devices.pc]
id     = "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6"
root   = 'F:\\'
joined = true

[devices.p53]
id     = "P53-ID-AFTER-INSTALL"
joined = false

# folders follow
[folders.Documents]
category = "synced"
ignore = [
    "/GitHub",
    "/Backup",
]

[folders."Documents/GitHub"]
category = "synced"

[folders.Videos]
category = "archive"

[folders.spisor-sites]
category = "local"

[folders.Projects]
priority = 90
`;

class FakeInstance implements JoinInstance {
  devices: SyncthingDeviceConfig[] = [];
  shares: string[] = [];
  constructor(
    readonly name: string,
    readonly folders: string[],
    readonly addresses = ["tcp://storage.example.ts.net:22000", "dynamic"],
  ) {}
  async myId() {
    return `${this.name.toUpperCase().padEnd(7, "X").slice(0, 7)}-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA`;
  }
  async addDevice(device: SyncthingDeviceConfig) {
    if (!this.devices.some((entry) => entry.deviceID === device.deviceID)) this.devices.push(device);
  }
  async shareFolder(folderId: string, deviceId: string) {
    if (!this.folders.includes(folderId)) return false;
    if (!this.shares.includes(`${folderId}:${deviceId}`)) this.shares.push(`${folderId}:${deviceId}`);
    return true;
  }
}

function setup(overrides: Partial<JoinDependencies> & { callers?: Record<string, WhoIs> } = {}) {
  const records: Record<string, JoinedDevice> = {};
  const commits: string[] = [];
  const activity: string[] = [];
  let invalidations = 0;
  const instance = new FakeInstance("private-array", ["documents", "documents-github", "projects", "videos"]);
  const callers: Record<string, WhoIs> = overrides.callers ?? {
    "100.64.0.5": { loginName: owner, tags: [], nodeName: "p53.example.ts.net", addresses: ["100.64.0.5/32"] },
    "100.64.0.6": { loginName: null, tags: ["tag:storage"], nodeName: "stick.example.ts.net", addresses: [] },
    "100.64.0.7": { loginName: "guest@example.com", tags: [], nodeName: "guest.example.ts.net", addresses: [] },
    "100.64.0.8": { loginName: null, tags: ["tag:server"], nodeName: "server.example.ts.net", addresses: [] },
  };
  const dependencies: JoinDependencies = {
    whois: async (address) => callers[address] ?? null,
    allowedUsers: async () => [owner],
    requiredTag: "tag:storage",
    instances: async () => [instance],
    layout: async () => parseLayout(layoutText),
    records: { all: async () => ({ ...records }), put: async (device) => void (records[device.name] = device) },
    recordInSetup: async (name, deviceId) => {
      commits.push(`${name} ${deviceId}`);
      return { committed: true, pushed: true, message: "committed and pushed" };
    },
    now: () => new Date("2026-10-20T12:00:00Z"),
    effects: { invalidate: () => void (invalidations += 1), record: (text) => void activity.push(text) },
    ...overrides,
  };
  return { dependencies, records, commits, instance, activity, invalidations: () => invalidations };
}

const p53Request = { name: "p53", os: "linux", syncthingDeviceId: p53Id, nodes: [{ kind: "drive", path: "/data", threshold: 80 }] };

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JoinError, `expected a JoinError, got ${error}`);
    return error.status;
  }
  assert.fail("the join was not refused");
}

describe("join admission", () => {
  it("admits a device owned by the tailnet's owner and answers with the admitted folders", async () => {
    const { dependencies, records, commits, instance } = setup();
    const { response } = await handleJoin(dependencies, ["100.64.0.5"], p53Request);
    assert.deepEqual(
      response.folders.map((folder) => [folder.id, folder.path]),
      [
        ["documents", "Documents"],
        ["documents-github", "Documents/GitHub"],
        ["projects", "Projects"],
      ],
    );
    assert.equal(response.devices.length, 1);
    assert.equal(response.devices[0].name, "private-array");
    assert.deepEqual(instance.devices.map((device) => device.deviceID), [p53Id]);
    assert.deepEqual(instance.shares.sort(), [`documents-github:${p53Id}`, `documents:${p53Id}`, `projects:${p53Id}`]);
    assert.equal(records.p53.syncthingDeviceId, p53Id);
    assert.deepEqual(commits, [`p53 ${p53Id}`]);
  });

  it("enters a join in Activity in words and drops the shared local build", async () => {
    const second = new FakeInstance("pc-data", ["documents"]);
    const { dependencies, instance, activity, invalidations } = setup();
    await handleJoin({ ...dependencies, instances: async () => [instance, second] }, ["100.64.0.5"], p53Request);
    assert.deepEqual(activity, ["p53 joined: added to private-array, pc-data"]);
    assert.equal(invalidations(), 1);
  });

  it("enters a device added to Syncthing but not recorded in the setup repo, and drops the shared build, when recording fails", async () => {
    const { dependencies, instance, activity, invalidations } = setup({
      recordInSetup: async () => {
        throw new Error("EACCES: permission denied, open '/setup/drive-sync.toml'");
      },
    });
    await assert.rejects(handleJoin(dependencies, ["100.64.0.5"], p53Request), /EACCES/);
    assert.deepEqual(instance.devices.map((device) => device.deviceID), [p53Id]);
    assert.deepEqual(activity, ["p53 was added to private-array but not recorded in the setup repo: EACCES: permission denied, open '/setup/drive-sync.toml'"]);
    assert.equal(invalidations(), 1);
  });

  it("enters nothing for a refused join", async () => {
    const { dependencies, activity, invalidations } = setup();
    await refusal(handleJoin(dependencies, ["100.64.0.7"], p53Request));
    await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, syncthingDeviceId: "not an id" }));
    assert.deepEqual(activity, []);
    assert.equal(invalidations(), 0);
  });

  it("admits a device tagged tag:storage whoever owns it", async () => {
    const { dependencies } = setup();
    const { response } = await handleJoin(dependencies, ["100.64.0.6"], { ...p53Request, name: "stick" });
    assert.ok(response.folders.length > 0);
  });

  it("refuses a caller outside the tailnet with 403", async () => {
    assert.equal(await refusal(handleJoin(setup().dependencies, ["203.0.113.9"], p53Request)), 403);
  });

  it("names the caller by the first address tailscale knows", async () => {
    const { response } = await handleJoin(setup().dependencies, ["127.0.0.1:41234", "100.64.0.5"], p53Request);
    assert.ok(response.devices.length > 0);
  });

  it("refuses a caller with no address with 403", async () => {
    assert.equal(await refusal(handleJoin(setup().dependencies, [], p53Request)), 403);
  });

  it("refuses another user's device and a device with another tag with 403", async () => {
    assert.equal(await refusal(handleJoin(setup().dependencies, ["100.64.0.7"], p53Request)), 403);
    assert.equal(await refusal(handleJoin(setup().dependencies, ["100.64.0.8"], p53Request)), 403);
  });

  it("refuses an untagged device when no user is allowed, as when this node is tagged", async () => {
    assert.equal(await refusal(handleJoin(setup({ allowedUsers: async () => [] }).dependencies, ["100.64.0.5"], p53Request)), 403);
  });

  it("admits a device of a user listed besides the owner", async () => {
    const { dependencies } = setup({ allowedUsers: async () => [owner, "guest@example.com"] });
    const { response } = await handleJoin(dependencies, ["100.64.0.7"], { ...p53Request, name: "guest" });
    assert.ok(response.devices.length > 0);
  });

  it("names the caller's login and the allowed users when it refuses", async () => {
    await assert.rejects(handleJoin(setup().dependencies, ["100.64.0.7"], p53Request), /guest\.example\.ts\.net \(guest@example\.com\) is neither owned by finn@example\.com/);
  });

  it("answers 200 again for the same name and ID without a second commit", async () => {
    const { dependencies, commits, instance } = setup();
    await handleJoin(dependencies, ["100.64.0.5"], p53Request);
    const layoutAfterCommit = parseLayout(layoutText.replace('id     = "P53-ID-AFTER-INSTALL"\njoined = false', `id     = "${p53Id}"\njoined = true`));
    const { response } = await handleJoin({ ...dependencies, layout: async () => layoutAfterCommit }, ["100.64.0.5"], p53Request);
    assert.equal(response.folders.length, 3);
    assert.equal(commits.length, 1);
    assert.equal(instance.devices.length, 1);
  });

  it("refuses a known name with another device ID with 409", async () => {
    const { dependencies } = setup();
    await handleJoin(dependencies, ["100.64.0.5"], p53Request);
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, syncthingDeviceId: otherId })), 409);
  });

  it("refuses a name the setup repo lists with another real ID with 409", async () => {
    const { dependencies } = setup();
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, name: "pc" })), 409);
  });

  it("treats a placeholder ID in the setup repo as not joined yet", async () => {
    const { dependencies } = setup();
    const { response } = await handleJoin(dependencies, ["100.64.0.5"], p53Request);
    assert.ok(response.devices.length > 0);
  });

  it("refuses a malformed request with 400", async () => {
    const { dependencies } = setup();
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, syncthingDeviceId: "nope" })), 400);
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, name: "P53!" })), 400);
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, nodes: [] })), 400);
    assert.equal(await refusal(handleJoin(dependencies, ["100.64.0.5"], { ...p53Request, nodes: [{ kind: "array", path: "/x", threshold: 0 }] })), 400);
  });

  it("checks the caller before the request, so a stranger learns nothing", async () => {
    assert.equal(await refusal(handleJoin(setup().dependencies, ["203.0.113.9"], {})), 403);
  });

  it("records locally and says so when no setup repo is configured", async () => {
    const { dependencies, records } = setup({ recordInSetup: null });
    const { setup: result } = await handleJoin(dependencies, ["100.64.0.5"], p53Request);
    assert.equal(result?.committed, false);
    assert.match(result?.message ?? "", /no setup repo/);
    assert.equal(records.p53.setup?.committed, false);
  });
});

describe("admitted folders", () => {
  const layout = parseLayout(layoutText);

  it("admits everything but priority 0 at threshold 0, archive included", () => {
    const folders = admittedFolders(layout, { ...p53Request, os: "linux", nodes: [{ kind: "drive", path: "/data", threshold: 0 }] } as never);
    assert.deepEqual(folders.map((folder) => folder.id).sort(), ["documents", "documents-github", "projects", "videos"]);
  });

  it("places a folder on the node with the lowest threshold that keeps it, relative to the first node and absolute on another", () => {
    const folders = admittedFolders(layout, {
      name: "pc",
      os: "windows",
      syncthingDeviceId: p53Id,
      nodes: [
        { kind: "folder", path: "D:\\files", threshold: 85 },
        { kind: "drive", path: "F:\\", threshold: 30 },
      ],
    });
    assert.deepEqual(
      folders.map((folder) => folder.path),
      ["F:\\Documents", "F:\\Documents\\GitHub", "F:\\Videos", "F:\\Projects"],
    );
  });

  it("admits nothing without a setup repo", () => {
    assert.deepEqual(admittedFolders(null, p53Request as never), []);
  });

  it("never admits the top directory's entry as a folder", () => {
    const withTop = parseLayout(`[folders."."]\npriority = 20\n${layoutText}`);
    const folders = admittedFolders(withTop, { ...p53Request, os: "linux", nodes: [{ kind: "drive", path: "/data", threshold: 0 }] } as never);
    assert.deepEqual(folders.map((folder) => folder.id).sort(), ["documents", "documents-github", "projects", "videos"]);
  });
});
