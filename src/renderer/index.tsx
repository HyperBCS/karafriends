import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";

import { LiveStateProvider } from "../common/apiClient";
import { createQueryClient } from "../common/apiQueries";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";
import KarafriendsAudio from "./webAudio";

const audio = new KarafriendsAudio();

const queryClient = createQueryClient();

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <LiveStateProvider>
          <App audio={audio} />
        </LiveStateProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
