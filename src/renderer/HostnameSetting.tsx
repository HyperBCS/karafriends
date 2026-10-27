import React from "react";

import { HOSTNAME } from "../common/constants";
import "./global";

// Which of this computer's names or addresses the QR code points phones at,
// with the remote's port: "karafriends.local:8080".
export default function HostnameSetting(props: {
  hostname: string;
  port: number;
  onChange: (hostname: string) => void;
}) {
  const names = [HOSTNAME, ...window.karafriends.ipAddresses()];
  return (
    <label className="kfLabel">
      Address
      <select
        className="kfField"
        value={props.hostname}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {names.map((name) => (
          <option key={name} value={`${name}:${props.port}`}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
