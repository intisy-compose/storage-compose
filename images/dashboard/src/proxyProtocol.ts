const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const fixedLength = 16;
const commandProxy = 0x21;
const tcpOverIpv4 = 0x11;
const tcpOverIpv6 = 0x21;
export const maxHeaderLength = fixedLength + 216;

export interface ProxySource {
  address: string;
  port: number;
}

export type ProxyParse =
  | { kind: "incomplete" }
  | { kind: "invalid"; reason: string }
  | { kind: "parsed"; source: ProxySource; headerLength: number };

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

/**
 * Reads a PROXY protocol v2 header from the start of a connection. Only a PROXY command for TCP over
 * IPv4 or IPv6 is accepted: the caller's address is the whole point, so LOCAL and UDP are refused.
 */
export function parseProxyV2(data: Buffer): ProxyParse {
  const comparable = Math.min(data.length, signature.length);
  if (!data.subarray(0, comparable).equals(signature.subarray(0, comparable))) return { kind: "invalid", reason: "no PROXY protocol v2 signature" };
  if (data.length < fixedLength) return { kind: "incomplete" };
  if (data[12] !== commandProxy) return { kind: "invalid", reason: `version and command 0x${data[12].toString(16)} is not v2 PROXY` };
  const family = data[13];
  if (family !== tcpOverIpv4 && family !== tcpOverIpv6) return { kind: "invalid", reason: `address family 0x${family.toString(16)} is not TCP over IPv4 or IPv6` };
  const addressLength = data.readUInt16BE(14);
  const required = family === tcpOverIpv4 ? 12 : 36;
  if (addressLength < required) return { kind: "invalid", reason: `an address block of ${addressLength} bytes is too short` };
  if (fixedLength + addressLength > maxHeaderLength) return { kind: "invalid", reason: `an address block of ${addressLength} bytes is too long` };
  if (data.length < fixedLength + addressLength) return { kind: "incomplete" };
  const block = data.subarray(fixedLength, fixedLength + addressLength);
  const source =
    family === tcpOverIpv4
      ? { address: Array.from(block.subarray(0, 4)).join("."), port: block.readUInt16BE(8) }
      : { address: ipv6Text(block.subarray(0, 16)), port: block.readUInt16BE(32) };
  return { kind: "parsed", source, headerLength: fixedLength + addressLength };
}
