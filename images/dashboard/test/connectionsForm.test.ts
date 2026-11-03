import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProfileChangedRefusal, isStrandedRefusal, strandedText } from "../src/api/profileText.js";
import type { ConnectionProfile, ProfileRead } from "../src/api/types.js";
import { defaultProfile } from "../src/connectionProfile.js";
import { ProfileChanged, ProfileConflict, ProfileStuck, ProfileUnreachable } from "../src/setupRepo.js";
import { clusterFormFor, followChangedProfile } from "../ui/src/connectionsForm.js";
import { followChangedLimits, limitsFormFor } from "../ui/src/optionsForm.js";

function read(change: (profile: ConnectionProfile) => void = () => {}): ProfileRead {
  const profile = defaultProfile();
  change(profile);
  return { profile, pulledAt: "2026-11-02T10:00:00.000Z", pullProblem: null, profileProblem: null };
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

describe("the form recognises a refused save by the server's own texts", () => {
  it("a profile changed on disk and a push another host beat are both a changed profile", () => {
    assert.equal(isProfileChangedRefusal(new ProfileChanged().message), true);
    assert.equal(isProfileChangedRefusal(new ProfileConflict().message), true);
    assert.equal(isProfileChangedRefusal(new ProfileUnreachable("could not resolve host").message), false);
  });

  it("a save left unpushed beneath another commit is a failure to show, not a changed profile to reload", () => {
    assert.equal(isProfileChangedRefusal(new ProfileStuck("abc1234").message), false);
    assert.equal(isStrandedRefusal(new ProfileStuck("abc1234").message), false);
  });

  it("a save that would strand pairs is recognised whatever the pairs", () => {
    assert.equal(isStrandedRefusal(strandedText([["aa01", "bb02"]])), true);
    assert.equal(isStrandedRefusal(new ProfileConflict().message), false);
  });
});
