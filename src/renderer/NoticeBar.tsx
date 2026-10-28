import React, { useState } from "react";

import { useLiveState } from "../common/apiClient";
import "./NoticeBar.css";

// One bar across the top for what the host should know: phones can't
// connect (the remote's server couldn't listen, say because its port is
// taken), or YouTube downloads keep failing (the tools problem). Both come
// with the live state. The show goes on either way. "Dismiss" hides it
// until something new comes up.
export default function NoticeBar() {
  const remoconProblem = useLiveState((state) => state?.remoconProblem ?? null);
  const toolsProblem = useLiveState((state) => state?.toolsProblem ?? null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const problems = [remoconProblem, toolsProblem].filter(
    (problem): problem is string => problem !== null,
  );
  const key = problems.join("\n");
  if (problems.length === 0 || key === dismissed) return null;
  return (
    <div className="noticeBar" role="alert">
      <div className="noticeBarText">
        {problems.map((problem) => (
          <p key={problem}>{problem}</p>
        ))}
      </div>
      <button
        type="button"
        className="kfButton"
        onClick={() => setDismissed(key)}
      >
        Dismiss
      </button>
    </div>
  );
}
