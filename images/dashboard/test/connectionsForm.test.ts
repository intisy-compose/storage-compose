import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectionProfile, ProfileRead } from "../src/api/types.js";
import { defaultProfile } from "../src/connectionProfile.js";
import { clusterFormFor, followChangedProfile } from "../ui/src/connectionsForm.js";
import { followChangedLimits, limitsFormFor } from "../ui/src/optionsForm.js";

function read(change: (profile: ConnectionProfile) => void = () => {}): ProfileRead {
  const profile = defaultProfile();
  change(profile);
  return { profile, pulledAt: "2026-11-02T10:00:00.000Z", pullProblem: null };
}

describe("a profile form after another host saved first", () => {
  it("the cluster form keeps a changed field and takes the other host's change after that 409", () => {
    const form = clusterFormFor(read());
    form.draft.nat = false;
    const theirs = read((profile) => (profile.limits.maxSendKbps = 300));
    followChangedProfile(form, theirs);
    assert.equal(form.followed, theirs);
    assert.equal(form.saved.maxSendKbps, 300);
    assert.equal(form.saved.nat, true);
    assert.equal(form.draft.maxSendKbps, 300, "the other host's change is taken");
    assert.equal(form.draft.nat, false, "the person's change is kept");
    assert.equal(form.result?.text, "Not saved: the profile changed since you read it; it has been reloaded. Your changes are kept: save again.");
  });

  it("a node's limits form keeps a changed limit and takes the other host's override after that 409", () => {
    const form = limitsFormFor("fb98", read());
    form.draft.maxRecvKbps = 50;
    const theirs = read((profile) => (profile.nodeLimits.fb98 = { maxSendKbps: 200 }));
    followChangedLimits("fb98", form, theirs);
    assert.equal(form.followed, theirs);
    assert.deepEqual(form.saved, { maxSendKbps: 200, maxRecvKbps: 0, limitLan: false });
    assert.deepEqual(form.draft, { maxSendKbps: 200, maxRecvKbps: 50, limitLan: false });
  });
});
