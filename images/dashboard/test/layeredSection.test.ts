import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes } from "../ui/src/format.js";
import { resumeText, spaceText } from "../ui/src/layeredSection.js";

describe("a node's space on its detail", () => {
  it("says what the round decided, with what the node needs and has", () => {
    assert.equal(spaceText({ state: "raised", threshold: 80, neededBytes: 100, availableBytes: 300 }), `short of space: its threshold is raised (needs ${formatBytes(100)}, has ${formatBytes(300)})`);
    assert.match(spaceText({ state: "full", threshold: 0, neededBytes: 1, availableBytes: 1 }), /^the cluster does not fit with 10% free: it confirms no new hand-off/);
    assert.equal(spaceText({ state: "unknown", threshold: 50, neededBytes: 1, availableBytes: 1 }), "unknown: a folder it keeps has no size yet, so nothing turns send-receive and nothing is handed off");
    assert.equal(spaceText(null), "not read: nothing turns send-receive and nothing is handed off");
  });

  it("says before a resume by hand whether a round would pause the folders again", () => {
    assert.match(resumeText("pc", 2, true), /^2 folders paused by a stop\. They resume by themselves .* its next round pauses them again\.$/);
    assert.equal(resumeText("pc", 1, false), "1 folder paused by a stop, and pc no longer acts on its plan, so no round resumes them. Type pc to resume them.");
  });
});
