import React from "react";

import { HOSTNAME } from "../common/constants";
import "./global";

// Which of this computer's names or addresses the QR code points phones at,
// with the remote's port: "karafriends.local:8080". One picked that this
// computer no longer has (a new network) still shows, as the QR code
// still has it, until another is picked.
export default function HostnameSetting(props: {
  hostname: string;
  onChange: (hostname: string) => void;
}) {
  const port = window.karafriends.remoconPort();
  const names = [HOSTNAME, ...window.karafriends.ipAddresses()];
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
