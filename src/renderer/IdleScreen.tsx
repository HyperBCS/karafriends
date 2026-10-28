import React from "react";

import "./IdleScreen.css";
import QRCode from "./QRCode";
import UpNext from "./UpNext";

// While no song plays: the remote's QR code and address, and what's queued.
export default function IdleScreen(props: {
  hostname: string;
  onOpenSettings: () => void;
}) {
  return (
    <div className="idleScreen">
      <button
        type="button"
        className="kfIconButton idleSettings"
        aria-label="Settings"
        onClick={props.onOpenSettings}
      >
        <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.14 12.94a7.07 7.07 0 0 0 .06-.94 7.07 7.07 0 0 0-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.62l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.4h-3.84a.48.48 0 0 0-.48.4l-.36 2.54a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.73 8.86a.48.48 0 0 0 .12.62l2.03 1.58a7.3 7.3 0 0 0 0 1.88l-2.03 1.58a.49.49 0 0 0-.12.62l1.92 3.32a.49.49 0 0 0 .59.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.05.23.25.4.48.4h3.84c.24 0 .44-.17.48-.4l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.62l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
          />
        </svg>
      </button>
      <div className="idleJoin">
        <div className="idleQRCode">
          <QRCode hostname={props.hostname} />
        </div>
        <p className="idleScan">Scan to join</p>
        <p className="idleAddress">{props.hostname}</p>
      </div>
      <UpNext layout="rows" />
    </div>
  );
}
