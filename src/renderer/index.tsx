import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { RelayEnvironmentProvider } from "react-relay";

import { LiveStateProvider } from "../common/apiClient";
import { createQueryClient } from "../common/apiQueries";
import environment from "../common/graphqlEnvironment";
import { KuroshiroSingleton } from "../common/joysoundParser";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";
import KarafriendsAudio from "./webAudio";

const kuroshiro = new Kuroshiro();
const kuromojiAnalyzer = new KuromojiAnalyzer({ dictPath: "./dict" });
const kuromojiPromise = kuroshiro.init(kuromojiAnalyzer);

const kuroshiroSingleton: KuroshiroSingleton = {
  kuroshiro,
  analyzer: kuromojiAnalyzer,
  analyzerInitPromise: kuromojiPromise,
};

const audio = new KarafriendsAudio();

const queryClient = createQueryClient();

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RelayEnvironmentProvider environment={environment}>
          <LiveStateProvider>
            <App kuroshiro={kuroshiroSingleton} audio={audio} />
          </LiveStateProvider>
        </RelayEnvironmentProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
