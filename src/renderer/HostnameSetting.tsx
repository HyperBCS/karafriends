import React from "react";

import "./global";

// Which of this computer's LAN addresses the QR code points phones at, with
// the remote's port: "192.168.1.20:8080". The first is the default. One
// shown that this computer no longer has (a new network) still shows, as
// the QR code still has it, until the display looks again.
export default function HostnameSetting(props: {
  hostname: string;
  onChange: (hostname: string) => void;
}) {
  const port = window.karafriends.remoconPort();
  const addresses = window.karafriends.ipAddresses();
  // No network: what the QR code says then (App.tsx's savedHostname).
  const names = addresses.length > 0 ? addresses : ["localhost"];
  const listed = names.some((name) => `${name}:${port}` === props.hostname);
  return (
    <label className="kfLabel">
      Address
      <select
        className="kfField"
        value={props.hostname}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {listed ? null : (
          <option value={props.hostname} disabled={true}>
            {`${props.hostname.slice(0, props.hostname.lastIndexOf(":"))} (not on this network now)`}
          </option>
        )}
        {names.map((name) => (
          <option key={name} value={`${name}:${port}`}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
