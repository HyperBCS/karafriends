// Runs on Node's test runner through tsx (yarn test:unit). The queries are
// datagrams as they arrive, decoded by dns-packet the way multicast-dns
// decodes them; the interfaces are os.networkInterfaces() lists. No socket
// is opened.
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, test } from "node:test";

import * as dnsPacket from "dns-packet";

import ipAddresses, { type Interfaces } from "../common/ipAddresses";
import { type MdnsReply, mdnsReplies } from "./mdns";

// Bytes from hex, with spaces, newlines and # comments ignored.
const datagram = (hex: string) =>
  dnsPacket.decode(
    Buffer.from(hex.replace(/#.*$/gm, "").replace(/\s+/g, ""), "hex"),
  );

// Android's DnsResolver: a one-shot query from a random port, RD set.
const ANDROID = datagram(`
  3c1d 0100 0001 0000 0000 0000           # id, RD, one question
  0b 6b617261667269656e6473 05 6c6f63616c 00  # karafriends.local
  0001 0001                               # A, IN
`);

// An iPhone batching a browse in front of its address questions, with the
// QU bit on the new name's (later names point back into the first).
const IPHONE = datagram(`
  0000 0000 0003 0000 0000 0000           # id 0, three questions
  08 5f616972706c6179 04 5f746370 05 6c6f63616c 00  # _airplay._tcp.local
  000c 0001                               # PTR, IN
  0b 6b617261667269656e6473 c01a          # karafriends + .local (offset 26)
  0001 8001                               # A, QU|IN
  c025                                    # karafriends.local (offset 37)
  001c 8001                               # AAAA, QU|IN
`);

// The same name asked again, from port 5353 without QU (QM).
const RECHECK = datagram(`
  0000 0000 0001 0000 0000 0000
  0b 6b617261667269656e6473 05 6c6f63616c 00
  0001 0001
`);

// dig -p 5353 @224.0.0.251 KaraFriends.local: capitals, EDNS with a cookie.
const DIG = datagram(`
  a1b2 0120 0001 0000 0000 0001           # id, RD+AD, one question, OPT
  0b 4b617261467269656e6473 05 6c6f63616c 00  # KaraFriends.local
  0001 0001                               # A, IN
  00 0029 1000 00000000 000c              # OPT: 4096-byte UDP, 12 bytes
  000a 0008 0123456789abcdef              # cookie
`);

// Someone else's name, and our name's AAAA alone.
const OTHER = datagram(`
  0000 0000 0001 0000 0000 0000
  10 4272616e646f6e732d4d6163426f6f6b 05 6c6f63616c 00  # Brandons-MacBook.local
  0001 0001
`);
const AAAA_ONLY = datagram(`
  0000 0000 0001 0000 0000 0000
  0b 6b617261667269656e6473 05 6c6f63616c 00
  001c 0001
`);

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

const answered = (reply: MdnsReply) =>
  (reply.packet.answers ?? []).map((answer) => answer.data);

// What goes on the wire: multicast-dns sends a response with AA set.
const onTheWire = (reply: MdnsReply) =>
  dnsPacket.decode(
    dnsPacket.encode({ ...reply.packet, type: "response", flags: 1 << 10 }),
  );

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

describe("mdnsReplies", () => {
  test("an Android phone's one-shot query gets a unicast answer", () => {
    const from = { address: "10.10.10.57", port: 41234 };
    const replies = mdnsReplies(ANDROID, from, LAPTOP);
    assert.equal(replies.length, 2);
    const [group, unicast] = replies;

    assert.equal(group.to, undefined);
    assert.deepEqual(answered(group), ["10.10.10.225"]);

    // To the port it asked from, with its id and question, and a short TTL.
    assert.deepEqual(unicast.to, from);
    const wire = onTheWire(unicast);
    assert.equal(wire.id, 0x3c1d);
    assert.deepEqual(wire.questions, [
      { name: "karafriends.local", type: "A", class: "IN" },
    ]);
    assert.deepEqual(
      wire.answers?.map(({ name, type, ttl, flush, data }) => ({
        name,
        type,
        ttl,
        flush,
        data,
      })),
      [
        {
          name: "karafriends.local",
          type: "A",
          ttl: 10,
          flush: false,
          data: "10.10.10.225",
        },
      ],
    );
  });

  test("a question after another one is still answered, unicast for QU", () => {
    const from = { address: "10.10.10.80", port: 5353 };
    const replies = mdnsReplies(IPHONE, from, LAPTOP);
    assert.deepEqual(
      replies.map((reply) => [reply.to, answered(reply)]),
      [
        [undefined, ["10.10.10.225"]],
        [from, ["10.10.10.225"]],
      ],
    );
    const [answer] = onTheWire(replies[0]).answers ?? [];
    assert.equal(answer.ttl, 120);
    assert.equal(answer.flush, true);
    // Only a legacy answer echoes the question and the id.
    assert.equal(onTheWire(replies[1]).questions?.length, 0);
  });

  test("a neighbour's QM query is answered unicast too, past a VPN", () => {
    // With the VPN up, the group reply leaves by the tunnel; the unicast one
    // to the phone takes the Wi-Fi.
    const from = { address: "10.10.10.80", port: 5353 };
    assert.deepEqual(
      mdnsReplies(RECHECK, from, LAPTOP).map((reply) => reply.to),
      [undefined, from],
    );
  });

  test("a query from off every subnet goes to the group only", () => {
    const from = { address: "172.17.0.5", port: 5353 };
    const replies = mdnsReplies(RECHECK, from, LAPTOP);
    assert.deepEqual(
      replies.map((reply) => [reply.to, answered(reply)]),
      [[undefined, ["10.10.10.225"]]],
    );
    // Unless it asks for unicast with the QU bit.
    assert.deepEqual(
      mdnsReplies(IPHONE, from, LAPTOP).map((reply) => reply.to),
      [undefined, from],
    );
  });

  test("the answer is the address on the querier's subnet", () => {
    const wired = { address: "192.168.50.77", port: 5353 };
    assert.deepEqual(mdnsReplies(RECHECK, wired, WINDOWS).map(answered), [
      ["192.168.50.3"],
      ["192.168.50.3"],
    ]);
    const wifi = { address: "192.168.1.9", port: 5353 };
    assert.deepEqual(mdnsReplies(RECHECK, wifi, WINDOWS).map(answered), [
      ["192.168.1.20"],
      ["192.168.1.20"],
    ]);
    // Off both: every LAN address, but never WSL's or the VPN's.
    const other = { address: "10.99.0.1", port: 5353 };
    assert.deepEqual(mdnsReplies(RECHECK, other, WINDOWS).map(answered), [
      ["192.168.1.20", "192.168.50.3"],
    ]);
  });

  test("the name matches in any letter case", () => {
    const from = { address: "10.10.10.30", port: 53111 };
    const replies = mdnsReplies(DIG, from, LAPTOP);
    assert.equal(replies.length, 2);
    const wire = onTheWire(replies[1]);
    assert.equal(wire.id, 0xa1b2);
    assert.deepEqual(wire.questions, [
      { name: "KaraFriends.local", type: "A", class: "IN" },
    ]);
    assert.deepEqual(answered(replies[1]), ["10.10.10.225"]);
  });

  test("other names, and AAAA alone, get no reply", () => {
    const from = { address: "10.10.10.80", port: 5353 };
    assert.deepEqual(mdnsReplies(OTHER, from, LAPTOP), []);
    assert.deepEqual(mdnsReplies(AAAA_ONLY, from, LAPTOP), []);
  });

  test("no IPv4 address at all: no reply", () => {
    const from = { address: "10.10.10.80", port: 5353 };
    assert.deepEqual(
      mdnsReplies(RECHECK, from, { tailscale0: LAPTOP.tailscale0 }),
      [],
    );
  });
});
