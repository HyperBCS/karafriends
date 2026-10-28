declare module "multicast-dns" {
  // A packet as dns-packet decodes and encodes it, as far as mdns.ts uses it.
  export interface MdnsQuestion {
    name: string;
    type: string;
    // "IN", "ANY", or "UNKNOWN_<n>" for a class dns-packet has no name for
    // (one with the QU bit set).
    class?: string;
  }
  export interface MdnsAnswer {
    name: string;
    type: string;
    class?: string;
    ttl?: number;
    flush?: boolean;
    data: string;
  }
  export interface MdnsPacket {
    id?: number;
    type?: "query" | "response";
    flags?: number;
    questions?: MdnsQuestion[];
    answers?: MdnsAnswer[];
  }
  // A datagram's sender.
  export interface RemoteInfo {
    address: string;
    port: number;
  }
  export default function mdns(): {
    on(
      packetType: "query",
      callback: (query: MdnsPacket, rinfo: RemoteInfo) => void,
    ): void;
    // To rinfo, or to the mDNS group without it.
    respond(packet: MdnsPacket, rinfo?: RemoteInfo): void;
  };
}

declare module "dns-packet" {
  import type { MdnsPacket } from "multicast-dns";
  export function encode(packet: MdnsPacket): Buffer;
  export function decode(buffer: Buffer): MdnsPacket;
}
