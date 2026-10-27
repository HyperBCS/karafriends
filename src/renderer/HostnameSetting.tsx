import React, { useId, useState } from "react";

import { HOSTNAME } from "../common/constants";
import "./global";

export default function HostnameSetting(props: {
  hostname: string;
  onChange: (name: string) => void;
}) {
  const port = window.karafriends.remoconPort();
  const hostnameToValue = new Map([
    ["offkai.karafriends.party", "offkai.karafriends.party"],
    [HOSTNAME, `${HOSTNAME}:${port}`],
    ...window.karafriends
      .ipAddresses()
      .map((address): [string, string] => [address, `${address}:${port}`]),
  ]);

  const [currentValue, setCurrentValue] = useState(
    hostnameToValue.get(props.hostname),
  );
  const id = useId();

  return (
    <div className="input-field">
      <select
        id={id}
        value={currentValue}
        onChange={(e) => {
          setCurrentValue(e.target.value);
          props.onChange(e.target.value);
        }}
      >
        {Array.from(hostnameToValue).map(([key, value]) => (
          <option key={value} value={value}>
            {key}
          </option>
        ))}
      </select>
      <label htmlFor={id}>Hostname</label>
    </div>
  );
}
