import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { RelayEnvironmentProvider } from "react-relay";

import { LiveStateProvider } from "../common/apiClient";
import { createQueryClient } from "../common/apiQueries";
import environment from "../common/graphqlEnvironment";
import App from "./App";
import "./index.module.scss";

const queryClient = createQueryClient();

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RelayEnvironmentProvider environment={environment}>
        <LiveStateProvider checkAdmin>
          <App />
        </LiveStateProvider>
      </RelayEnvironmentProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
