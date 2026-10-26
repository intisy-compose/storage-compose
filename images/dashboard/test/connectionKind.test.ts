import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closestKind, connectionKind } from "../src/connectionKind.js";

const arrayId = "X7KCOB7-4ZJQ2RT-W352REX-D36FWRQ-YSGVXEA-6YA5PZK-PHYIU5M-32WVQQ4";
const laptopId = "LAPTOPA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const localDeviceIds = new Set([arrayId]);

function kindOf(address: string | null, type = "tcp-client", deviceId = laptopId) {
  return connectionKind({ deviceId, connected: true, type, address, localDeviceIds });
}

describe("connection kind", () => {
  it("a peer that is another instance of this host is this device even over a tailnet address", () => {
    assert.equal(kindOf("100.75.83.74:22000", "tcp-client", arrayId), "this-device");
    assert.equal(kindOf("relay://203.0.113.9:22067", "relay-client", arrayId), "this-device");
  });

  it("relay-client is relay before the address is looked at", () => {
    assert.equal(kindOf("192.168.1.5:22067", "relay-client"), "relay");
    assert.equal(kindOf("100.75.83.74:22067", "relay-server"), "relay");
  });

  it("100.75.83.74 and fd7a:115c:a1e0::1 are tailscale", () => {
    assert.equal(kindOf("100.75.83.74:22000"), "tailscale");
    assert.equal(kindOf("100.64.0.1:22000"), "tailscale");
    assert.equal(kindOf("[fd7a:115c:a1e0::1]:22000"), "tailscale");
    assert.equal(kindOf("100.128.0.1:22000"), "internet");
  });

  it("192.168.1.5, 172.18.0.4, 169.254.1.1 and fe80::1 are local network", () => {
    for (const address of ["192.168.1.5:22000", "172.18.0.4:22000", "169.254.1.1:22000", "[fe80::1%eth0]:22000", "10.1.2.3:22000", "127.0.0.1:22000", "[::1]:22000", "[fd00::5]:22000", "[::ffff:192.168.1.5]:22000"]) {
      assert.equal(kindOf(address), "local-network", address);
    }
    assert.equal(kindOf("172.32.0.1:22000"), "internet");
  });

  it("8.8.8.8 is internet", () => {
    assert.equal(kindOf("8.8.8.8:22000"), "internet");
    assert.equal(kindOf("[2001:4860:4860::8888]:22000"), "internet");
  });

  it("[fd7a:115c:a1e0::1]:22000 and tcp://100.75.83.74:22000 parse", () => {
    assert.equal(kindOf("tcp://100.75.83.74:22000"), "tailscale");
    assert.equal(kindOf("quic://[fd7a:115c:a1e0::1]:22000", "quic-client"), "tailscale");
    assert.equal(kindOf("fd7a:115c:a1e0::1"), "tailscale");
    assert.equal(kindOf("192.168.1.5"), "local-network");
  });

  it("not connected is null", () => {
    assert.equal(connectionKind({ deviceId: arrayId, connected: false, type: null, address: null, localDeviceIds }), null);
    assert.equal(connectionKind({ deviceId: laptopId, connected: false, type: "tcp-client", address: "8.8.8.8:22000", localDeviceIds }), null);
  });

  it("the closest of several kinds wins, relay last", () => {
    assert.equal(closestKind(["relay", "internet", "tailscale"]), "tailscale");
    assert.equal(closestKind(["tailscale", "local-network"]), "local-network");
    assert.equal(closestKind(["relay", "this-device"]), "this-device");
    assert.equal(closestKind([]), null);
  });
});
