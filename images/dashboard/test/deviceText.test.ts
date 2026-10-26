import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressLabel, listedAddresses, reachTone } from "../src/api/deviceText.js";
import type { StorageNode } from "../src/api/types.js";

function node(overrides: Partial<StorageNode>): Pick<StorageNode, "online" | "sync"> {
  return { online: true, sync: { state: "idle", completion: 100, lastSeen: null }, ...overrides };
}

describe("device text", () => {
  it("unspecified listen addresses are left out", () => {
    const addresses = ["tcp://0.0.0.0:22000", "quic://[::]:22000", "tcp://:22000", "tcp://192.168.1.5:22000", "::", "100.75.76.90:22001"];
    assert.deepEqual(listedAddresses(addresses), ["tcp://192.168.1.5:22000", "100.75.76.90:22001"]);
  });

  it("a relay address shows its host only", () => {
    assert.equal(addressLabel("relay://203.0.113.9:22067/?id=ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ12-3456789-ABCDEFG-HIJKLMN-OPQRSTU&pingInterval=1m0s"), "relay 203.0.113.9");
    assert.equal(addressLabel("relay://[2001:db8::1]:22067/?id=ABC"), "relay 2001:db8::1");
    assert.equal(addressLabel("tcp://192.168.1.5:22000"), "tcp://192.168.1.5:22000");
  });

  it("an online node with warnings is still online", () => {
    assert.equal(reachTone(node({})), "ok");
    assert.equal(reachTone(node({ sync: { state: "error", completion: 40, lastSeen: null } })), "ok");
    assert.equal(reachTone(node({ online: false })), "muted");
    assert.equal(reachTone(node({ sync: { state: "offline", completion: 0, lastSeen: null } })), "muted");
  });
});
