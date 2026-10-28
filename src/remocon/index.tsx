import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";

import { LiveStateProvider } from "../common/apiClient";
import { createQueryClient } from "../common/apiQueries";
import App from "./App";
import { QueueNotifications } from "./hooks/useQueueNotifications";
import { LanguageProvider } from "./i18n";
import "./index.scss";

const queryClient = createQueryClient();

// iOS Safari only shows :active (the buttons' pressed state) on a page that
// listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveStateProvider checkAdmin>
        {/* Outside LanguageProvider, so a language change doesn't remount
            it and repeat a notification (t() translates them as they go
            out). */}
        <QueueNotifications />
        {/* Inside the data providers: a language change remounts the app
            but keeps the queries and the live connection. */}
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </LiveStateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
