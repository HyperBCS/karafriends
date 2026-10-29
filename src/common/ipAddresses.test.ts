// Runs on Node's test runner through tsx (yarn test:unit). The interfaces
// are os.networkInterfaces() lists.
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, test } from "node:test";

import ipAddresses, { type Interfaces } from "./ipAddresses";

const iface = (
  address: string,
  netmask: string,
  more: Partial<NetworkInterfaceInfo> = {},
): NetworkInterfaceInfo =>
  ({
    address,
    netmask,
    family: address.includes(":") ? "IPv6" : "IPv4",
    mac: "84:7b:57:c0:26:9b",
    internal: false,
    cidr: null,
    ...more,
  }) as NetworkInterfaceInfo;
const NO_MAC = { mac: "00:00:00:00:00:00" };

// This laptop with the Japan VPN on (a WireGuard tunnel named for its
// server), Docker and Tailscale.
const LAPTOP: Interfaces = {
  lo: [
    iface("127.0.0.1", "255.0.0.0", { internal: true, ...NO_MAC }),
    iface("::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", { internal: true }),
  ],
  wlp0s20f3: [
    iface("10.10.10.225", "255.255.255.0"),
    iface("fe80::2743:4c61:3d40:893f", "ffff:ffff:ffff:ffff::"),
  ],
  jp206: [
    iface("10.2.0.2", "255.255.255.255", NO_MAC),
    iface("2a07:b944::2:2", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", NO_MAC),
  ],
  tailscale0: [iface("fe80::a361:f79d:2e22:9f63", "ffff:ffff:ffff:ffff::")],
  docker0: [
    iface("172.17.0.1", "255.255.0.0", { mac: "02:42:ac:11:00:01" }),
    iface("fe80::78d6:8eff:fe88:3297", "ffff:ffff:ffff:ffff::"),
  ],
};

// A Windows laptop on Wi-Fi and wired Ethernet (two subnets), with WSL, an
// OpenVPN adapter and an Ethernet port that got no DHCP answer.
const WINDOWS: Interfaces = {
  "Wi-Fi": [
    iface("fd00::1c2e:5b1a:9e0f:4d3c", "ffff:ffff:ffff:ffff::"),
    iface("192.168.1.20", "255.255.255.0"),
  ],
  Ethernet: [iface("192.168.50.3", "255.255.255.0")],
  "Ethernet 3": [iface("169.254.12.34", "255.255.0.0")],
  "vEthernet (WSL)": [iface("172.28.16.1", "255.255.240.0")],
  "OpenVPN TAP-Windows6": [iface("10.8.0.6", "255.255.255.0")],
  "Loopback Pseudo-Interface 1": [
    iface("127.0.0.1", "255.0.0.0", { internal: true }),
  ],
};

describe("ipAddresses", () => {
  test("only the Wi-Fi's IPv4 address, not the VPN, Docker or IPv6", () => {
    assert.deepEqual(ipAddresses(LAPTOP), ["10.10.10.225"]);
  });

  test("each LAN's address, without WSL, a VPN or a self-assigned one", () => {
    assert.deepEqual(ipAddresses(WINDOWS), ["192.168.1.20", "192.168.50.3"]);
  });

  test("an adapter it doesn't know beats no address at all", () => {
    assert.deepEqual(
      ipAddresses({
        wg0: [iface("10.66.0.2", "255.255.255.0", NO_MAC)],
        eth0: [iface("169.254.3.3", "255.255.0.0")],
        lo: [iface("127.0.0.1", "255.0.0.0", { internal: true })],
      }),
      ["10.66.0.2"],
    );
    assert.deepEqual(
      ipAddresses({
        lo: [iface("127.0.0.1", "255.0.0.0", { internal: true })],
      }),
      [],
    );
  });
});
