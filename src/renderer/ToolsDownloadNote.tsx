import React from "react";

import { useLiveState } from "../common/apiClient";
import "./ToolsDownloadNote.css";

// ffmpeg and yt-dlp's first download, while it runs: YouTube and Niconico
// songs wait for it. On the idle screen and the setup screen.
export default function ToolsDownloadNote() {
  const download = useLiveState((state) => state?.toolsDownload ?? null);
  if (!download) return null;
  return (
    <p className="toolsDownload" role="status">
      Setting up YouTube
      {download.percent === null ? "…" : `… ${download.percent}%`}
    </p>
  );
}
