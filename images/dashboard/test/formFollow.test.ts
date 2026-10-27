import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FolderSettings, InstanceOptions } from "../src/api/types.js";
import { followSavedConfig } from "../ui/src/formFollow.js";
import { generalFormFor, settleGeneralSave } from "../ui/src/generalForm.js";

function folder(): FolderSettings {
  return {
    id: "dashboard-test-a",
    label: "dashboard-test-a",
    path: "/var/syncthing/data/dashboard-test-a",
    type: "sendreceive",
    paused: false,
    rescanIntervalS: 3600,
    fsWatcherEnabled: true,
    fsWatcherDelayS: 10,
    ignorePerms: false,
    order: "random",
    minDiskFree: { value: 1, unit: "%" },
    maxConflicts: 10,
    syncOwnership: false,
    syncXattrs: false,
    devices: [{ deviceId: "OTHER", encrypted: true }],
    versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" },
  };
}

/** A folder as the advanced editor's answer has it: Syncthing's own keys, shaped differently where the form's are its own. */
function advancedFolder(changes: Record<string, unknown>): Record<string, unknown> {
  const { devices, versioning, ...rest } = folder();
  return { ...rest, ...changes, devices: devices.map((device) => ({ deviceID: device.deviceId, introducedBy: "" })), versioning: { ...versioning, fsType: "basic" }, copiers: 0, markerName: ".stfolder" };
}

describe("a form beside the advanced editor follows its save", () => {
  it("takes every key the answer carries in the form's own shape, and keeps the rest", () => {
    const followed = followSavedConfig(folder(), folder(), advancedFolder({ maxConflicts: 11, minDiskFree: { unit: "GB", value: 2 }, label: "renamed" }));
    assert.equal(followed.saved.maxConflicts, 11);
    assert.deepEqual(followed.saved.minDiskFree, { value: 2, unit: "GB" });
    assert.equal(followed.saved.label, "renamed");
    assert.deepEqual(followed.saved.devices, [{ deviceId: "OTHER", encrypted: true }], "a key shaped otherwise in the form is kept");
    assert.deepEqual(followed.saved.versioning, folder().versioning);
    assert.deepEqual(followed.draft, followed.saved, "an untouched form shows the saved values");
  });

  it("keeps what the person typed into the form and follows only the fields they left alone", () => {
    const draft = { ...folder(), rescanIntervalS: 60, maxConflicts: 5 };
    const followed = followSavedConfig(folder(), draft, advancedFolder({ maxConflicts: 11, fsWatcherDelayS: 20 }));
    assert.equal(followed.saved.maxConflicts, 11);
    assert.equal(followed.draft.maxConflicts, 5, "a typed value stays");
    assert.equal(followed.draft.rescanIntervalS, 60);
    assert.equal(followed.draft.fsWatcherDelayS, 20, "an untouched field follows the save");
  });

  it("ignores a key whose type differs from the form's", () => {
    const followed = followSavedConfig(folder(), folder(), advancedFolder({ maxConflicts: "11", order: 3 }));
    assert.equal(followed.saved.maxConflicts, 10);
    assert.equal(followed.saved.order, "random");
  });
});

function options(deviceName: string): InstanceOptions {
  return {
    deviceName,
    listenAddresses: ["tcp://:22199"],
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    globalAnnounceServers: ["default"],
    relaysEnabled: false,
    natEnabled: false,
    maxSendKbps: 0,
    maxRecvKbps: 0,
    limitBandwidthInLan: false,
    minHomeDiskFree: { value: 1, unit: "%" },
    urAccepted: -1,
    crashReportingEnabled: true,
    reconnectionIntervalS: 60,
    alwaysLocalNets: [],
  };
}

describe("the general form after a save whose options could not be read again", () => {
  it("keeps what was saved until a newer read of the options arrives", () => {
    const before = options("dashboard-test-peer");
    const form = generalFormFor("follow-a", before);
    form.draft.deviceName = "renamed-peer";
    form.draft.keepFree = 2;
    settleGeneralSave("follow-a", form, { settings: null, problem: null });
    assert.equal(form.saved.deviceName, "renamed-peer");
    assert.equal(form.draft.deviceName, "renamed-peer");
    assert.equal(form.saved.keepFree, 2);
    assert.equal(generalFormFor("follow-a", before).draft.deviceName, "renamed-peer", "the read from before the save does not undo it");
    assert.equal(generalFormFor("follow-a", options("renamed-peer")).saved.deviceName, "renamed-peer");
    assert.equal(generalFormFor("follow-a", options("changed-elsewhere")).draft.deviceName, "changed-elsewhere", "a newer read is followed");
  });

  it("keeps a rename that was saved and the other settings still to save when they were not", () => {
    const before = options("dashboard-test-peer");
    const form = generalFormFor("follow-b", before);
    form.draft.deviceName = "renamed-peer";
    form.draft.keepFree = 2;
    settleGeneralSave("follow-b", form, { settings: null, problem: "the other settings were not saved" });
    assert.equal(form.saved.deviceName, "renamed-peer");
    assert.equal(form.saved.keepFree, 1);
    assert.equal(form.draft.keepFree, 2, "the unsaved value stays in the form to save again");
    assert.equal(generalFormFor("follow-b", before).draft.deviceName, "renamed-peer");
  });
});
