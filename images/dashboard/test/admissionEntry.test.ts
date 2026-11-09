import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admissionText } from "../ui/src/admissionEntry.js";

describe("a node waiting for admission on Requests", () => {
  it("says what accepting commits, and that the node only reports after it", () => {
    const text = admissionText({ nodeId: "b001", name: "stick", source: "registry", host: "storage", threshold: 80, listed: false });
    assert.equal(text, "stick (b001) on storage: the layout does not list it yet; its node file suggests threshold 80. Admitting commits admitted = true at the threshold confirmed here, so other nodes may share with it, and apply = false: it only reports until apply is turned on for it.");
    assert.match(admissionText({ nodeId: "b001", name: "stick", source: "registry", host: "storage", threshold: 80, listed: true }), /the layout lists it, not admitted yet/);
  });

  it("says plainly that refusing a claim refuses the id for every device, and only for a claimed node", () => {
    const claimed = admissionText({ nodeId: "b001", name: "stick", source: "joined", host: "storage", threshold: 80, listed: false, claimedBy: { deviceId: "LAPTOP", deviceName: "laptop" } });
    assert.match(claimed, /Refusing refuses the id b001 for every device that reports it, not only for laptop\./);
    assert.doesNotMatch(admissionText({ nodeId: "b001", name: "stick", source: "registry", host: "storage", threshold: 80, listed: false }), /Refusing/);
  });
});
