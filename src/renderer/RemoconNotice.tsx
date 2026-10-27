import React, { useEffect, useState } from "react";

import "./global";
import "./RemoconNotice.css";

// A banner across the top of the display when phones can't connect, say
// because the remote's port is taken. The display works without the remote's
// server, so the show goes on; the banner only says why the phones don't.
// Clicking "Dismiss" hides it.
export default function RemoconNotice() {
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      window.karafriends.onRemoconProblem((message) => {
        setProblem(message);
        setDismissed(false);
      }),
    [],
  );

  if (problem === null || dismissed) return null;
  return (
    <div className="remoconNotice" role="alert">
      <span>{problem}</span>
      <button type="button" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
