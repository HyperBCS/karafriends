// Answers mDNS queries for karafriends.local, so phones can open the QR
// code's address. The decisions are mdnsReplies(), a pure function; the
// rest is the socket.
import { EventEmitter } from "events";
import { networkInterfaces } from "os";

import mdns, {
  type MdnsPacket,
  type MdnsQuestion,
  type RemoteInfo,
} from "multicast-dns";

import { HOSTNAME } from "../common/constants";
import { type Interfaces, lanAddresses, onSubnet } from "../common/ipAddresses";

const MDNS_PORT = 5353;

// RFC 6762's TTL for a host's address records, and the most a legacy
// (one-shot) answer may give (section 6.7).
const TTL = 120;
const LEGACY_TTL = 10;

// The top bit of a question's class asks for a unicast answer (QU). dns-packet
// 5 doesn't strip it: it decodes the class to a name first, so a QU question
// for IN comes out as "UNKNOWN_32769".
const QU_BIT = 0x8000;
const CLASS_IN = 1;
const CLASS_ANY = 255;

function questionClass(question: MdnsQuestion) {
  const klass = question.class ?? "IN";
  if (klass === "IN") return { code: CLASS_IN, unicast: false };
  if (klass === "ANY") return { code: CLASS_ANY, unicast: false };
  const code = Number(/^UNKNOWN_(\d+)$/.exec(klass)?.[1]);
  return { code: code & ~QU_BIT, unicast: (code & QU_BIT) !== 0 };
}

// A question this host answers: A (or ANY) for karafriends.local in any
// letter case, class IN or ANY.
function isForUs(question: MdnsQuestion) {
  const { code } = questionClass(question);
  return (
    question.name.toLowerCase() === HOSTNAME &&
    (question.type === "A" || question.type === "ANY") &&
    (code === CLASS_IN || code === CLASS_ANY)
  );
}

export interface MdnsReply {
  packet: MdnsPacket;
  // Where to send it; none means the mDNS group, 224.0.0.251:5353.
  to?: RemoteInfo;
}

// The replies to one query from `from`: none unless a question asks for
// karafriends.local's address. The answer is this host's address on the
// querier's subnet, so a VPN or a VM's adapter never comes into it (every
// LAN address when the querier is on none of them).
//
// It always goes to the group, and unicast to the querier too when:
// - it asked from a port other than 5353 (a one-shot query, RFC 6762 6.7:
//   Android's resolver listens for the answer only on the socket it asked
//   from), which gets the query's id and question back and a short TTL;
// - it set the QU bit (asked for a unicast answer);
// - it is on one of this host's subnets: a multicast reply leaves by the
//   routing table, which a VPN can point at its tunnel, but a unicast one to
//   a neighbour always takes the LAN.
export function mdnsReplies(
  query: MdnsPacket,
  from: RemoteInfo,
  interfaces: Interfaces,
): MdnsReply[] {
  const questions = (query.questions ?? []).filter(isForUs);
  if (questions.length === 0) return [];

  const lan = lanAddresses(interfaces);
  const local = lan.filter((address) => onSubnet(address, from.address));
  const addresses = (local.length ? local : lan).map((a) => a.address);
  if (addresses.length === 0) return [];

  const answers = (ttl: number, flush: boolean) =>
    addresses.map((data) => ({
      name: HOSTNAME,
      type: "A",
      class: "IN",
      ttl,
      // Replace whatever the querier cached for the name (not in a legacy
      // answer, whose querier isn't an mDNS cache).
      flush,
      data,
    }));

  const replies: MdnsReply[] = [{ packet: { answers: answers(TTL, true) } }];
  if (from.port !== MDNS_PORT) {
    replies.push({
      packet: {
        id: query.id,
        questions: questions.map(({ name, type }) => ({
          name,
          type,
          class: "IN",
        })),
        answers: answers(LEGACY_TTL, false),
      },
      to: from,
    });
  } else if (
    questions.some((question) => questionClass(question).unicast) ||
    local.length > 0
  ) {
    replies.push({ packet: { answers: answers(TTL, true) }, to: from });
  }
  return replies;
}

export default function setupMdns() {
  const mdnsObj = mdns();
  // The mDNS socket is an EventEmitter; an unhandled "error" event (e.g. a
  // transient network/socket error) would throw and take down the whole app.
  // mDNS is best-effort discovery, so log and keep running instead. (The
  // multicast-dns typings only declare the "query" event, hence the cast.)
  (mdnsObj as unknown as EventEmitter).on("error", (err: unknown) => {
    console.error("mDNS error:", err);
  });
  mdnsObj.on("query", (query, rinfo) => {
    try {
      for (const { packet, to } of mdnsReplies(
        query,
        rinfo,
        networkInterfaces(),
      )) {
        mdnsObj.respond(packet, to && { address: to.address, port: to.port });
      }
    } catch (err) {
      // Runs in an event-emitter callback, so a throw here is uncaught.
      console.error("Failed to respond to mDNS query:", err);
    }
  });
}
