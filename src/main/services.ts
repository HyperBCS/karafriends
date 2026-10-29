// The main process's single instances: the shared state (saved in queue.json
// in userData), the admin sessions (adminSessions.json, next to it), the DAM/Joysound/YouTube clients, the live-state hub, and the
// API handlers built on them, which the JSON RPC router serves.
import path from "path";

import { app } from "electron";
import { Innertube } from "youtubei.js";

import { configStore } from "../common/config";
import { toolsStatus, updateTools } from "../common/externalResources";
import { songFilesOf } from "../common/songFiles";
import {
  createDownloads,
  DOWNLOADS_FOLDER,
  getNicoVideoInfo,
  OLD_DOWNLOADS_FOLDER,
  stopAllTools,
} from "./downloads";
import {
  moveOldQueue,
  moveOldSongFiles,
  sweepHalfDone,
} from "./downloads/folder";
import { createAdminSessions, endSessionsOnPasswordChange } from "./adminAuth";
import { createApi, type ApiHandlers } from "./api";
import { createCredentialProviders, memoizeSuccess } from "./credentials";
import { DkwebsysAPI, MinseiAPI } from "./damApi";
import { JoysoundAPI } from "./joysoundApi";
import { createJoysoundLinker, type StoredLink } from "./joysoundLink";
import { createLiveHub } from "./live";
import { createSecretFile } from "./secretFile";
import { createSettingsHandlers } from "./settings";
import { createStateStore } from "./state";
import { withTimeout } from "./timeout";

// The running config, kept up to date by configStore.update().
const karafriendsConfig = configStore.get();

// Older versions kept the saved queue with the downloads in the temp
// folder: it comes over once, with the files of the songs it holds.
const QUEUE_FILE = path.join(app.getPath("userData"), "queue.json");
const queueMoved = moveOldQueue(OLD_DOWNLOADS_FOLDER, QUEUE_FILE);

export const store = createStateStore(QUEUE_FILE);

if (queueMoved) {
  const { currentSong, songQueue } = store.getState();
  moveOldSongFiles(
    OLD_DOWNLOADS_FOLDER,
    DOWNLOADS_FOLDER,
    [currentSong, ...songQueue].flatMap((song) =>
      song ? [songFilesOf(song)] : [],
    ),
  );
}
// Nothing is downloading yet, so what downloads left half-done is from
// before: it goes.
sweepHalfDone(DOWNLOADS_FOLDER);

export const hub = createLiveHub(store, karafriendsConfig);

// The remote's server can't take connections (its port is taken, say), so
// phones can't connect. The display works without it, and shows why.
export function reportRemoconProblem(message: string) {
  store.update((state) => {
    state.remoconProblem = message;
  });
}

export const adminSessions = createAdminSessions(
  path.join(app.getPath("userData"), "adminSessions.json"),
);

// A new password (from setAdminPassword or importConfig) signs every phone
// out, and the live state tells the phones signed in to ask whoami again.
endSessionsOnPasswordChange(configStore, adminSessions, () =>
  store.update((state) => {
    state.adminSignOuts++;
  }),
);

// karafriends' link to the Joysound account (joysoundLink.ts), kept in
// userData encrypted by the OS: not in config.yaml, so Export config leaves
// it out.
const joysoundLinker = createJoysoundLinker({
  store: createSecretFile<StoredLink>(
    path.join(app.getPath("userData"), "joysoundLink.bin"),
    "Joysound link",
  ),
});

// A link made for one account is never used for another: a new email
// drops it (and the shared link goes too, below).
configStore.onChange(({ keys }) => {
  if (keys.includes("joysoundEmail")) {
    joysoundLinker.forgetOtherAccounts(configStore.get().joysoundEmail);
  }
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
  joysoundLogin: (email, password) => joysoundLinker.link(email, password),
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

// Only youtubeInfo needs the YouTube client, so it is created on first use
// there: a YouTube outage then only affects YouTube lookups. A failure (or
// a timeout) isn't kept, so the next lookup tries again.
const innertubeApiProvider = memoizeSuccess(() =>
  withTimeout(Innertube.create(), 30_000, "Innertube.create"),
);

const { resumeDownloads: resume, ...queueApi } = createApi({
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

// Starts again the downloads a restart cut short (queue.json's pending
// songs). For index.ts, once the app is ready.
export const resumeDownloads = resume;

export const api: ApiHandlers = {
  ...queueApi,
  ...createSettingsHandlers({
    store: configStore,
    // Fresh logins, so a test never touches the clients' shared ones.
    // Joysound's signs in to the website and says how the kept link stands,
    // without linking anything.
    logins: {
      dam: async (username, password) => {
        await MinseiAPI.login(username, password);
      },
      joysound: (email, password) => joysoundLinker.test(email, password),
    },
    restart: () => {
      // app.exit skips will-quit, where they are stopped otherwise.
      stopAllTools();
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
