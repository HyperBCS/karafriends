// The main process's single instances: the shared state (saved in queue.json
// in userData), the admin sessions (adminSessions.json, next to it), the DAM/Joysound/YouTube clients, the live-state hub, and the
// API handlers built on them, which the JSON RPC router serves.
import path from "path";

import { app } from "electron";
import { Innertube } from "youtubei.js";

import { configStore } from "../common/config";
import {
  DAM_LOGIN_KEYS,
  hasLogin,
  JOYSOUND_LOGIN_KEYS,
} from "../common/configSchema";
import {
  checkForToolUpdates,
  onFirstToolsDownload,
  toolsStatus,
  updateTools,
} from "../common/externalResources";
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
import { CATALOGS, createCatalogs, fakeCatalogs } from "./catalogs";
import {
  createCredentialProviders,
  LoginWarning,
  memoizeSuccess,
} from "./credentials";
import { damPictureUrl, DkwebsysAPI, MinseiAPI } from "./damApi";
import { JoysoundAPI } from "./joysoundApi";
import { createJoysoundLinker, type StoredLink } from "./joysoundLink";
import { createLiveHub } from "./live";
import { createSecretFile } from "./secretFile";
import { createSongPictures } from "./songPictures";
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

// ffmpeg and yt-dlp's first download, for the display (and its setup
// screen) to say YouTube is getting ready.
onFirstToolsDownload((progress) =>
  store.update((state) => {
    state.toolsDownload = progress;
  }),
);

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
    void joysoundLinker.forgetOtherAccounts(configStore.get().joysoundEmail);
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

// Whether DAM's and Joysound's songs are on: each login is checked now, at
// launch, and again when it changes (after credentials.ts has dropped the
// old session). The phones see it in the live state.
const catalogs = createCatalogs({
  enabled: (service) =>
    service === "dam"
      ? configStore.get().damEnabled
      : configStore.get().joysoundEnabled,
  hasLogin: (service) => hasLogin(configStore.get(), service),
  signIn: {
    dam: async () => {
      await credentials.dam();
    },
    // Linked, but to an account that can't download songs: they'd be
    // previews.
    joysound: async () => {
      const link = await credentials.joysound();
      if (link.membershipType !== "PAID") {
        throw new LoginWarning(
          "This Joysound account has no paid membership " +
            `(${link.membershipType ?? "none"}), so its songs can't be ` +
            "downloaded.",
        );
      }
    },
  },
  forget: {
    dam: () => credentials.dam.forget(),
    joysound: () => credentials.joysound.forget(),
  },
  onChange: (statuses) =>
    store.update((state) => {
      state.catalogs = statuses;
    }),
  fake: fakeCatalogs(process.env.KARAFRIENDS_FAKE_CATALOGS),
});
for (const service of CATALOGS) void catalogs.check(service);
configStore.onChange(({ keys }) => {
  const changed = (watched: readonly string[]) =>
    keys.some((key) => watched.includes(key));
  if (changed([...DAM_LOGIN_KEYS, "damEnabled"])) void catalogs.check("dam");
  if (changed([...JOYSOUND_LOGIN_KEYS, "joysoundEnabled"])) {
    void catalogs.check("joysound");
  }
});

// The clients keep no per-request state, so every request shares one of each.
const upstreamClients = {
  minsei: new MinseiAPI(credentials.dam),
  joysound: new JoysoundAPI(credentials.joysound),
  dkwebsys: new DkwebsysAPI(),
};

// The song pages' pictures, through this PC (/api/songPicture): a song
// page's lookup leaves its picture's URL, or the song is looked up again.
export const songPictures = createSongPictures({
  lookUp: async (kind, id) =>
    kind === "dam"
      ? damPictureUrl(
          (await upstreamClients.dkwebsys.getMusicDetailsInfo(id)).list[0]
            ?.mModelMusicInfoList[0]?.thumbnailPath,
        )
      : kind === "joysound"
        ? (await upstreamClients.joysound.getSongDetail(id)).pictureUrl
        : ((await upstreamClients.joysound.getFeatures()).find(
            (feature) => feature.id === id,
          )?.pictureUrl ?? null),
});

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
  pictures: songPictures,
  catalogs,
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
    // The host's Switch: the clients then check their link again (a lookup
    // that found the link taken failed, so none is kept, but a link to a
    // free account may be).
    // A login that just worked turns its catalog on, if it was off: a
    // fresh sign-in, as the test's.
    loginWorked: (service) => {
      if (!catalogs.isOn(service))
        void catalogs.check(service, { fresh: true });
    },
    switchJoysoundLink: async (email, password) => {
      const note = await joysoundLinker.switchLink(email, password);
      credentials.joysound.forget();
      return note;
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
      check: checkForToolUpdates,
      update: async () => {
        const updated = await updateTools();
        if (updated.length > 0) {
          store.update((state) => {
            state.toolsProblem = null;
          });
        }
        return updated;
      },
    },
  }),
};
