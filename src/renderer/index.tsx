import React from "react";
import { createRoot } from "react-dom/client";

import { LiveStateProvider } from "../common/apiClient";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";
import KarafriendsAudio from "./webAudio";

const audio = new KarafriendsAudio();

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* No query client: the display gets the live state over IPC, and
          runs its commands with call(). */}
      <LiveStateProvider>
        <App audio={audio} />
      </LiveStateProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
