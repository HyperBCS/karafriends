import { networkInterfaces, type NetworkInterfaceInfo } from "os";

// os.networkInterfaces(): each interface's name and its addresses.
export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

// Adapters that aren't the room's network: VMs and containers, mesh VPNs,
// tunnels, Apple's peer-to-peer links. Phones on the Wi-Fi can't reach them.
const VIRTUAL =
  /^(docker|br-|veth|virbr|vboxnet|vmnet|vnic|lxc|lxd|cni|flannel|cali|podman|tailscale|zt|utun|tun|tap|wg|ppp|ipsec|gif|stf|awdl|llw|anpi|bridge|ham)|vEthernet|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|WireGuard|OpenVPN|TAP-|Wintun|NordLynx|ProtonVPN|Mullvad|Hamachi|Bluetooth/i;

const isIPv4 = (iface: NetworkInterfaceInfo) =>
  // Node 18.0-18.3 said 4.
  iface.family === "IPv4" || (iface.family as unknown) === 4;

// 169.254.x.x: the address an adapter gives itself without DHCP.
const isLinkLocal = (address: string) => address.startsWith("169.254.");

// A tunnel (WireGuard, OpenVPN's tun, PPP) has no MAC address, and a VPN's
// address is often a /32 of its own: neither is a network phones are on.
const isTunnel = (iface: NetworkInterfaceInfo) =>
  iface.mac === "00:00:00:00:00:00" || iface.netmask === "255.255.255.255";

// This computer's IPv4 addresses on the room's network: what phones can
// open the remote at, for the QR code and the display's Address picker,
// the first one by default. Not IPv6 (a URL needs it bracketed), loopback,
// self-assigned, VPN or virtual adapters. If that leaves nothing (an adapter
// this doesn't know), every non-loopback IPv4 address is better than none.
export default function ipAddresses(
  interfaces: Interfaces = networkInterfaces(),
): string[] {
  const ipv4 = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (iface) =>
          isIPv4(iface) && !iface.internal && !isLinkLocal(iface.address),
      )
      .map((iface) => ({ name, iface })),
  );
  const lan = ipv4.filter(
    ({ name, iface }) => !VIRTUAL.test(name) && !isTunnel(iface),
  );
  // One entry per address, though two adapters can share one.
  return [
    ...new Set((lan.length ? lan : ipv4).map(({ iface }) => iface.address)),
  ];
}
