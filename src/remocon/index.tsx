import React from "react";
import { createRoot } from "react-dom/client";
import { RelayEnvironmentProvider } from "react-relay";

import { LiveStateProvider } from "../common/apiClient";
import environment from "../common/graphqlEnvironment";
import App from "./App";
import "./index.module.scss";

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <RelayEnvironmentProvider environment={environment}>
      <LiveStateProvider checkAdmin>
        <App />
      </LiveStateProvider>
    </RelayEnvironmentProvider>
  </React.StrictMode>,
);
