import React, { useId, useState } from "react";

import "./global";
import { parseCustomUrl } from "./remoteAddress";
import { Hint } from "./settings/controls";

// The Address select's choice for a custom URL.
const CUSTOM = "custom";

// Which of this computer's LAN addresses the QR code points phones at, with
// the remote's port ("192.168.1.20:8080"), or a custom URL (custom: picked,
// with a URL or one still being typed). The first address is the default.
// One shown that this computer no longer has (a new network) still shows,
// as the QR code still has it, until the display looks again.
export default function HostnameSetting(props: {
  hostname: string;
  custom: boolean;
  onChange: (hostname: string) => void;
  onPickCustom: () => void;
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
        value={props.custom ? CUSTOM : props.hostname}
        onChange={(event) =>
          event.target.value === CUSTOM
            ? props.onPickCustom()
            : props.onChange(event.target.value)
        }
      >
        {listed || props.custom ? null : (
          <option value={props.hostname} disabled={true}>
            {`${props.hostname.slice(0, props.hostname.lastIndexOf(":"))} (unavailable)`}
          </option>
        )}
        {names.map((name) => (
          <option key={name} value={`${name}:${port}`}>
            {name}
          </option>
        ))}
        <option value={CUSTOM}>Custom URL…</option>
      </select>
    </label>
  );
}

// The custom URL, under the Address once it's picked: saved as the host
// leaves the field or presses Enter, if it's one (parseCustomUrl), and shown
// as saved; if not, why not, and the QR code keeps what it had.
export function CustomUrlSetting(props: {
  url: string | null;
  onChange: (url: string) => void;
}) {
  const hintId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(props.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const parsed = parseCustomUrl(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setDraft(parsed.url);
    if (parsed.url !== props.url) props.onChange(parsed.url);
  };
  return (
    <div className="settingsField">
      <label className="kfLabel">
        Custom URL
        <input
          className="kfField"
          type="text"
          inputMode="url"
          value={draft}
          placeholder="https://karaoke.example.ts.net"
          autoComplete="off"
          spellCheck={false}
          // Picking Custom URL… opens it to type in.
          autoFocus={props.url === null}
          aria-invalid={error !== null}
          aria-describedby={error === null ? hintId : `${errorId} ${hintId}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </label>
      {error === null ? null : (
        <div className="settingsMessage problem" role="alert">
          <p id={errorId}>{error}</p>
        </div>
      )}
      <Hint id={hintId}>
        For access through Tailscale, port forwarding or a reverse proxy. Enter
        the address only, with no path. If it&apos;s reachable from the
        internet, set an admin password.
      </Hint>
    </div>
  );
}
