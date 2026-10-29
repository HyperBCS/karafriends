import React, { useState } from "react";

import type { CatalogStatus } from "../common/api";
import { useLiveState } from "../common/apiClient";
import "./NoticeBar.css";

// What the bar says about a catalog with a problem (catalogs.ts): DAM or
// Joysound can't be reached (it's tried again by itself), or its login was
// refused. Null for one that's fine, or off.
function catalogNotice(status: CatalogStatus | undefined): string | null {
  if (status?.state === "unreachable") {
    return `${status.reason} karafriends tries again by itself.`;
  }
  if (status?.state === "failed") return status.reason;
  return null;
}

// One bar across the top for what the host should know: phones can't
// connect (the remote's server couldn't listen, say because its port is
// taken), YouTube downloads keep failing (the tools problem), or DAM's or
// Joysound's songs are off because their login doesn't work. All come with
// the live state. The show goes on either way. "Dismiss" hides it until
// something new comes up.
export default function NoticeBar() {
  const remoconProblem = useLiveState((state) => state?.remoconProblem ?? null);
  const toolsProblem = useLiveState((state) => state?.toolsProblem ?? null);
  const damNotice = useLiveState((state) => catalogNotice(state?.catalogs.dam));
  const joysoundNotice = useLiveState((state) =>
    catalogNotice(state?.catalogs.joysound),
  );
  const [dismissed, setDismissed] = useState<string | null>(null);

  const problems = [
    remoconProblem,
    toolsProblem,
    damNotice,
    joysoundNotice,
  ].filter((problem): problem is string => problem !== null);
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
