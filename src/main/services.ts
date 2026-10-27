// The main process's single instances: the shared state (saved in queue.json
// next to the downloads), the DAM/Joysound/YouTube clients, the live-state
// hub, and the API handlers built on them, which the JSON RPC router
// serves.
import path from "path";

import { Innertube } from "youtubei.js";

import karafriendsConfig from "../common/config";
import {
  downloadDamVideo,
  downloadJoysoundData,
  downloadNicoVideo,
  downloadYoutubeVideo,
  getNicoVideoInfo,
  TEMP_FOLDER,
} from "../common/videoDownloader";
import { createApi } from "./api";
import { DkwebsysAPI, MinseiAPI } from "./damApi";
import { JoysoundAPI } from "./joysoundApi";
import { createLiveHub } from "./live";
import { createStateStore } from "./state";

export const store = createStateStore(path.resolve(TEMP_FOLDER, "queue.json"));

export const hub = createLiveHub(store, karafriendsConfig);

// Like memoize, but forgets a rejected promise so a failed login (wrong
// credentials, no Japanese IP, service down) is retried on the next request
// instead of failing until restart.
function memoizeSuccess<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = fn().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

const minseiCredentialsProvider = memoizeSuccess(async () => {
  const { damUsername, damPassword } = karafriendsConfig;
  const minseiLoginResult = await MinseiAPI.login(damUsername, damPassword);
  return {
    userCode: damUsername,
    authToken: minseiLoginResult.data.authToken,
  };
});

const joysoundCredentialsProvider = memoizeSuccess(async () => {
  const joysoundEmail = encodeURIComponent(karafriendsConfig.joysoundEmail);
  const joysoundPassword = encodeURIComponent(
    karafriendsConfig.joysoundPassword,
  );
  return JoysoundAPI.login(joysoundEmail, joysoundPassword);
});

// The clients keep no per-request state, so every request shares one of each.
const upstreamClients = {
  minsei: new MinseiAPI(minseiCredentialsProvider),
  joysound: new JoysoundAPI(joysoundCredentialsProvider),
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
  ...upstreamClients,
  youtube: innertubeApiProvider,
  getNicoVideoInfo,
  downloads: {
    dam: downloadDamVideo,
    joysound: (item, pushToHead, onReady) =>
      downloadJoysoundData(
        store.getState().downloadQueue,
        item.user,
        upstreamClients.joysound,
        item,
        pushToHead,
        onReady,
      ),
    youtube: (item, captionCode, onReady) =>
      downloadYoutubeVideo(
        store.getState().downloadQueue,
        item.user,
        item.songId,
        captionCode,
        onReady,
      ),
    nico: (item, onReady) =>
      downloadNicoVideo(
        store.getState().downloadQueue,
        item.user,
        item.songId,
        onReady,
      ),
  },
  publish: hub.publish,
});
