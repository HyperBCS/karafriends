// The main process's single instances: the shared state (saved in queue.json
// next to the downloads), the admin sessions (adminSessions.json in
// userData), the DAM/Joysound/YouTube clients, the live-state hub, and the
// API handlers built on them, which the JSON RPC router serves.
import path from "path";

import { app } from "electron";
import { Innertube } from "youtubei.js";

import { configStore } from "../common/config";
import { toolsStatus, updateTools } from "../common/externalResources";
import { createDownloads, getNicoVideoInfo, TEMP_FOLDER } from "./downloads";
import {
  createAdminSessions,
  createSetAdminPassword,
  endSessionsOnPasswordChange,
} from "./adminAuth";
import { createApi, type ApiHandlers } from "./api";
import { createCredentialProviders } from "./credentials";
import { DkwebsysAPI, MinseiAPI } from "./damApi";
import { JoysoundAPI } from "./joysoundApi";
import { createLiveHub } from "./live";
import { createSettingsHandlers } from "./settings";
import { createStateStore } from "./state";

// The running config, kept up to date by configStore.update().
const karafriendsConfig = configStore.get();

export const store = createStateStore(path.resolve(TEMP_FOLDER, "queue.json"));

export const hub = createLiveHub(store, karafriendsConfig);

export const adminSessions = createAdminSessions(
  path.join(app.getPath("userData"), "adminSessions.json"),
);

// Sets the admin password ("" for none) and signs every phone out. For the
// display's settings; no phone can call it.
export const setAdminPassword = createSetAdminPassword({
  config: karafriendsConfig,
  saveConfig: (values) => configStore.update(values),
});

// A new password (from setAdminPassword or importConfig) signs every phone
// out.
endSessionsOnPasswordChange(configStore, adminSessions);

// The clients' shared logins, forgotten when the settings change them.
const credentials = createCredentialProviders({
  store: configStore,
  damLogin: async (damUsername, damPassword) => {
    const minseiLoginResult = await MinseiAPI.login(damUsername, damPassword);
    return {
      userCode: damUsername,
      authToken: minseiLoginResult.data.authToken,
    };
  },
  joysoundLogin: (email, password) => JoysoundAPI.login(email, password),
});

configStore.onChange(({ keys }) => {
  // The phones' live state shows supervisedMode and everyoneIsAdmin.
  if (keys.includes("supervisedMode") || keys.includes("everyoneIsAdmin"))
    hub.refresh();
});

// The clients keep no per-request state, so every request shares one of each.
const upstreamClients = {
  minsei: new MinseiAPI(credentials.dam),
  joysound: new JoysoundAPI(credentials.joysound),
  dkwebsys: new DkwebsysAPI(),
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timer),
  ) as Promise<T>;
}

// Only youtubeInfo needs the YouTube client, so it is created on first use
// there: a YouTube outage then only affects YouTube lookups. memoize would
// cache a rejected promise forever, so use a manual singleton that times out
// and clears itself on failure so the next lookup retries.
let innertubePromise: Promise<Innertube> | null = null;
function innertubeApiProvider(): Promise<Innertube> {
  if (!innertubePromise) {
    innertubePromise = withTimeout(
      Innertube.create(),
      30000,
      "Innertube.create",
    ).catch((err) => {
      innertubePromise = null;
      throw err;
    });
  }
  return innertubePromise;
}

const queueApi = createApi({
  config: karafriendsConfig,
  store,
  adminSessions,
  ...upstreamClients,
  youtube: innertubeApiProvider,
  getNicoVideoInfo,
  downloads: createDownloads(
    () => store.getState().downloadQueue,
    upstreamClients.joysound,
  ),
  publish: hub.publish,
});

export const api: ApiHandlers = {
  ...queueApi,
  ...createSettingsHandlers({
    store: configStore,
    setAdminPassword,
    // Fresh logins, so a test never touches the clients' shared ones.
    logins: {
      dam: (username, password) => MinseiAPI.login(username, password),
      joysound: (email, password) => JoysoundAPI.login(email, password),
    },
    restart: () => {
      app.relaunch();
      app.exit(0);
    },
    tools: {
      status: () => {
        const { toolsProblem } = store.getState();
        return {
          ...toolsStatus(),
          problem: toolsProblem?.message ?? null,
          problemSince: toolsProblem?.since ?? null,
        };
      },
      update: async () => {
        await updateTools();
        store.update((state) => {
          state.toolsProblem = null;
        });
      },
    },
  }),
};
