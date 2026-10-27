// The main process's single instances: the shared state (saved in queue.json
// next to the downloads), the admin sessions (adminSessions.json in
// userData), the DAM/Joysound/YouTube clients, the live-state hub, and the
// API handlers built on them, which the JSON RPC router serves.
import path from "path";

import { app } from "electron";
import { Innertube } from "youtubei.js";

import { configStore } from "../common/config";
import { PROXY_KEYS } from "../common/configSchema";
import {
  downloadDamVideo,
  downloadJoysoundData,
  downloadNicoVideo,
  downloadYoutubeVideo,
  getNicoVideoInfo,
  TEMP_FOLDER,
} from "../common/videoDownloader";
import { createAdminSessions, createSetAdminPassword } from "./adminAuth";
import { createApi } from "./api";
import { createCredentialProviders } from "./credentials";
import { DkwebsysAPI, MinseiAPI } from "./damApi";
import { setProxy } from "./http";
import { JoysoundAPI } from "./joysoundApi";
import { createLiveHub } from "./live";
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
  sessions: adminSessions,
});

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

// The clients' requests go through config.yaml's proxy, if it enables one.
setProxy(karafriendsConfig);

configStore.onChange(({ keys }) => {
  // The phones' live state shows supervisedMode.
  if (keys.includes("supervisedMode")) hub.refresh();
  // For DAM and Joysound requests from now on. (The display's own proxy,
  // for DAM streams, changes on restart.)
  if (keys.some((key) => PROXY_KEYS.includes(key))) setProxy(karafriendsConfig);
  // A new password (from importConfig, say) signs every phone out, as
  // setAdminPassword does.
  if (
    keys.includes("adminPasswordHash") ||
    keys.includes("adminPasswordSalt")
  ) {
    adminSessions.clear();
  }
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

export const api = createApi({
  config: karafriendsConfig,
  store,
  adminSessions,
  ...upstreamClients,
  youtube: innertubeApiProvider,
  getNicoVideoInfo,
  downloads: {
    dam: downloadDamVideo,
    joysound: (item, pushToHead, onReady, onFailed) =>
      downloadJoysoundData(
        store.getState().downloadQueue,
        item.user,
        upstreamClients.joysound,
        item,
        pushToHead,
        onReady,
        onFailed,
      ),
    youtube: (item, captionCode, onReady, onFailed) =>
      downloadYoutubeVideo(
        store.getState().downloadQueue,
        item.user,
        item.songId,
        captionCode,
        onReady,
        onFailed,
      ),
    nico: (item, onReady, onFailed) =>
      downloadNicoVideo(
        store.getState().downloadQueue,
        item.user,
        item.songId,
        onReady,
        onFailed,
      ),
  },
  publish: hub.publish,
});
