import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressLabel, connectionKindText, deviceStateText, driveLastSeenHereText, driveWhereText, listedAddresses, reachTone, seenTimeText } from "../src/api/deviceText.js";
import type { DeviceSummary, DriveSummary, StorageNode } from "../src/api/types.js";

function node(overrides: Partial<StorageNode>): Pick<StorageNode, "online" | "sync"> {
  return { online: true, sync: { state: "idle", completion: 100, lastSeen: null }, ...overrides };
}

const now = new Date(2026, 9, 26, 16, 0);

function at(month: number, day: number, hour: number, minute: number): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString();
}

function device(overrides: Partial<DeviceSummary>): DeviceSummary {
  return {
    key: "p53", name: "p53", thisHost: false, online: false, connection: null, perInstance: [], lastSeen: null, lastConnection: null,
    deviceIds: [], nodeIds: [], driveKeys: [], sources: ["history"], ...overrides,
  };
}

function drive(overrides: Partial<DriveSummary>): DriveSummary {
  return {
    key: "serial:WKD082MD", label: "5784-data1", kind: "array-member", serial: "WKD082MD", size: null, arrayId: "5784", nodeId: null, attachments: [],
    present: false, currentHost: null, lastHost: "finn", lastAt: at(10, 21, 12, 0), ...overrides,
  };
}

describe("device text", () => {
  it("connection kinds read as the spec names them", () => {
    assert.equal(connectionKindText("this-device"), "this device");
    assert.equal(connectionKindText("tailscale"), "Tailscale");
    assert.equal(connectionKindText("local-network"), "local network");
    assert.equal(connectionKindText("relay"), "relay");
    assert.equal(connectionKindText("internet"), "internet");
    const connected = device({ online: true, connection: { kind: "tailscale", address: "100.64.0.12:22000", type: "tcp-client", nodeId: "fb98" } });
    assert.equal(deviceStateText(connected, now), "connected over Tailscale");
  });

  it("an offline device reads last seen <time> over <kind>", () => {
    const seen = at(10, 3, 18, 20);
    const offline = device({ lastSeen: seen, lastConnection: { kind: "local-network", address: "192.168.0.77:22000", at: seen } });
    assert.equal(deviceStateText(offline, now), "last seen 3 Oct, 18:20 over local network");
    assert.equal(deviceStateText(device({ lastSeen: seen }), now), "last seen 3 Oct, 18:20");
    assert.equal(seenTimeText(new Date(2025, 11, 30, 9, 5).toISOString(), now), "30 Dec 2025, 09:05");
  });

  it("a device never connected says so", () => {
    assert.equal(deviceStateText(device({}), now), "never connected");
    assert.equal(deviceStateText(device({ thisHost: true, online: true }), now), "this device");
  });

  it("a drive says where it is, or where and when it was last", () => {
    assert.equal(driveWhereText(drive({}), now), "not attached; last on finn 21 Oct, 12:00");
    assert.equal(driveLastSeenHereText(drive({}), now), "last seen here 21 Oct, 12:00");
    const attached = drive({ present: true, currentHost: "p53", attachments: [{ host: "p53", since: at(10, 25, 8, 30), lastAt: at(10, 26, 15, 0), endedAt: null, as: "data1 of private-array" }] });
    assert.equal(driveWhereText(attached, now), "on p53 since 25 Oct, 08:30");
    assert.equal(driveWhereText(drive({ lastHost: null, lastAt: null }), now), "never seen attached");
  });

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
