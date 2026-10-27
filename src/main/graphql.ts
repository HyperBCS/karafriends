// The GraphQL API, kept while clients move to the JSON RPC API (Phase 5 of
// notes/PLAN-hard-fork.md). Each resolver calls the matching handler in
// api.ts and adapts its result to the schema: connections and cursors,
// __typename, userIdentity.
import { createServer } from "http";
import { WebSocketServer } from "ws";

import { ApolloServer } from "@apollo/server";
import {
  ApolloServerPluginCacheControlDisabled,
  ApolloServerPluginInlineTraceDisabled,
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginSchemaReportingDisabled,
  ApolloServerPluginUsageReportingDisabled,
} from "@apollo/server/plugin/disabled";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { expressMiddleware } from "@as-integrations/express5";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { app as electronApp, dialog } from "electron";
import isDev from "electron-is-dev";
import express, { Application } from "express";
import { PubSub } from "graphql-subscriptions";
import { useServer } from "graphql-ws/use/ws";

import rawSchema from "inline-string:../common/schema.graphql";
import type {
  AdhocLyricsEntry,
  DamArtist,
  DamSong,
  Page,
  PlaybackState,
  QueueItem,
  QueueSongInput,
  QueueSongResult,
  UserIdentity,
} from "../common/api";
import karafriendsConfig from "../common/config";
import { getVideoDownloadProgress } from "./../common/videoDownloader";
import type { Caller } from "./api";
import { api, hub, store, upstreamClients } from "./services";
import type { State } from "./state";

import "regenerator-runtime/runtime";

interface Context {
  dataSources: typeof upstreamClients;
  caller: Caller;
}

interface PageArgs {
  first?: number | null;
  after?: string | null;
}

type QueueSongArgs<T> = {
  input: T & {
    songId: string;
    name: string;
    artistName: string;
    playtime?: number | null;
    userIdentity: UserIdentity;
  };
  tryHeadOfQueue: boolean;
};

// A DAM artist, maybe with the page of songs fetched along with it.
type ArtistParent = DamArtist & {
  songs?: Page<DamSong>;
  songsArgs?: { offset: number; limit: number };
};

enum SubscriptionEvent {
  CurrentSongAdhocLyricsChanged = "CurrentSongAdhocLyricsChanged",
  CurrentSongChanged = "CurrentSongChanged",
  Emote = "Emote",
  PitchShiftSemisChanged = "PitchShiftSemisChanged",
  PlaybackStateChanged = "PlaybackStateChanged",
  QueueAdded = "QueueAdded",
  QueueChanged = "QueueChanged",
}

// The state keeps queue items in the API's shape (src/common/api.ts); the
// schema wants a __typename and userIdentity instead of kind and user.
const TYPENAME_BY_KIND = {
  dam: "DamQueueItem",
  joysound: "JoysoundQueueItem",
  youtube: "YoutubeQueueItem",
  nico: "NicoQueueItem",
} as const;

function toGqlItem(item: QueueItem) {
  const { kind, user, ...fields } = item;
  return { __typename: TYPENAME_BY_KIND[kind], ...fields, userIdentity: user };
}

function toGqlItemOrNull(item: QueueItem | null) {
  return item ? toGqlItem(item) : null;
}

// Relay pages with `first` and an `after` cursor. A cursor is the offset of
// the next item, counted from `base` (Joysound counts from 1).
function pageArgs(args: PageArgs, base: 0 | 1, defaultLimit: number) {
  const after = args.after ? parseInt(args.after, 10) : NaN;
  return {
    offset: Number.isInteger(after) && after >= base ? after - base : 0,
    limit: args.first && args.first > 0 ? args.first : defaultLimit,
  };
}

function toConnection<T, N>(
  page: Page<T>,
  { offset, limit }: { offset: number; limit: number },
  base: 0 | 1,
  toNode: (item: T) => N,
) {
  return {
    edges: page.items.map((item, i) => ({
      node: toNode(item),
      cursor: (base + offset + i + 1).toString(),
    })),
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: page.nextOffset !== null,
      startCursor: base.toString(),
      endCursor: (base + offset + limit).toString(),
    },
  };
}

function toQueueSongResult(result: QueueSongResult) {
  return result.ok
    ? { __typename: "QueueSongInfo", eta: result.eta }
    : { __typename: "QueueSongError", reason: result.reason };
}

// The queue mutations carry the singer's identity in the input, as they
// always have, rather than in the request headers.
function queueSong<T>(
  args: QueueSongArgs<T>,
  context: Context,
  toInput: (input: QueueSongArgs<T>["input"]) => QueueSongInput,
) {
  const { userIdentity } = args.input;
  return api
    .queueSong(
      { ...toInput(args.input), tryHeadOfQueue: args.tryHeadOfQueue },
      {
        ...context.caller,
        deviceId: userIdentity.deviceId,
        nickname: userIdentity.nickname,
      },
    )
    .then(toQueueSongResult);
}

function songFields(input: {
  songId: string;
  name: string;
  artistName: string;
  playtime?: number | null;
}) {
  return {
    songId: input.songId,
    name: input.name,
    artistName: input.artistName,
    playtime: input.playtime ?? null,
  };
}

const pubsub = new PubSub();

// Publishes the subscription events for whatever an update changed.
store.onChange(
  (() => {
    const snapshot = (state: Readonly<State>) => ({
      queue: JSON.stringify(state.songQueue),
      currentSong: JSON.stringify(state.currentSong),
      playbackState: state.playbackState,
      pitchShiftSemis: state.pitchShiftSemis,
      adhocLyrics: JSON.stringify(state.currentSongAdhocLyrics),
    });
    let published = snapshot(store.getState());
    return (state: Readonly<State>) => {
      const next = snapshot(state);
      if (
        next.queue !== published.queue ||
        next.currentSong !== published.currentSong
      ) {
        pubsub.publish(SubscriptionEvent.QueueChanged, {
          queueChanged: {
            currentSong: toGqlItemOrNull(state.currentSong),
            newQueue: state.songQueue.map(toGqlItem),
          },
        });
      }
      if (next.currentSong !== published.currentSong) {
        pubsub.publish(SubscriptionEvent.CurrentSongChanged, {
          currentSongChanged: toGqlItemOrNull(state.currentSong),
        });
      }
      if (next.playbackState !== published.playbackState) {
        pubsub.publish(SubscriptionEvent.PlaybackStateChanged, {
          playbackStateChanged: state.playbackState,
        });
      }
      if (next.pitchShiftSemis !== published.pitchShiftSemis) {
        pubsub.publish(SubscriptionEvent.PitchShiftSemisChanged, {
          pitchShiftSemisChanged: state.pitchShiftSemis,
        });
      }
      if (next.adhocLyrics !== published.adhocLyrics) {
        pubsub.publish(SubscriptionEvent.CurrentSongAdhocLyricsChanged, {
          currentSongAdhocLyricsChanged: [...state.currentSongAdhocLyrics],
        });
      }
      published = next;
    };
  })(),
);

hub.onMessage((message) => {
  switch (message.type) {
    case "emote":
      pubsub.publish(SubscriptionEvent.Emote, {
        emote: { emote: message.emote, userIdentity: message.user },
      });
      break;
    case "queueAdded":
      pubsub.publish(SubscriptionEvent.QueueAdded, {
        queueAdded: toGqlItem(message.item),
      });
      break;
  }
});

const songsOfArtist = async (
  parent: ArtistParent,
  args: PageArgs,
  { caller }: Context,
) => {
  const page = pageArgs(args, 0, 30);
  // artistById already fetched this page with the artist.
  const songs =
    parent.songs &&
    parent.songsArgs?.offset === page.offset &&
    parent.songsArgs.limit === page.limit
      ? parent.songs
      : (await api.damArtist({ id: parent.id, ...page }, caller)).songs;
  return toConnection(songs, page, 0, (song) => song);
};

function fetchStreamingUrls(songId: string, { dataSources }: Context) {
  return dataSources.minsei.getMusicStreamingUrls(songId).then((data) =>
    data.list.map((info) => ({
      url: karafriendsConfig.useLowBitrateUrl
        ? info.lowBitrateUrl
        : info.highBitrateUrl,
    })),
  );
}

function fetchScoringData(songId: string, { dataSources }: Context) {
  return dataSources.minsei
    .getScoringData(songId)
    .then((data) => Array.from(new Uint8Array(data)));
}

const resolvers = {
  Artist: {
    songs: songsOfArtist,
  },
  DamQueueItem: {
    // popSong fetches these with the song; other queries fetch them here.
    streamingUrls: (
      parent: { songId: string; streamingUrls?: string[] },
      _: unknown,
      context: Context,
    ) =>
      parent.streamingUrls
        ? parent.streamingUrls.map((url) => ({ url }))
        : fetchStreamingUrls(parent.songId, context),
    scoringData: (
      parent: { songId: string; scoringData?: number[] },
      _: unknown,
      context: Context,
    ) => parent.scoringData ?? fetchScoringData(parent.songId, context),
  },
  Song: {
    lyricsPreview: (parent: { lyricsPreview?: string | null }) =>
      parent.lyricsPreview || null,
    vocalTypes: (parent: { vocalTypes?: string[] }) => parent.vocalTypes || [],
    tieUp: (parent: { tieUp?: string | null }) => parent.tieUp || null,
    playtime: (parent: { playtime?: number | null }) => parent.playtime || null,
    // No client asks for these on a Song (only on a DamQueueItem).
    streamingUrls: (parent: { id: string }, _: unknown, context: Context) =>
      fetchStreamingUrls(parent.id, context),
    scoringData: (parent: { id: string }, _: unknown, context: Context) =>
      fetchScoringData(parent.id, context),
  },
  Query: {
    adhocLyrics: (_: unknown, args: { id: string }, { caller }: Context) =>
      api.adhocLyrics({ songId: args.id }, caller),
    joysoundSongDetail: (
      _: unknown,
      args: { id: string | null },
      { caller }: Context,
    ) => api.joysoundSong({ id: args.id ?? "" }, caller),
    joysoundSongsByArtist: async (
      _: unknown,
      args: { artistId: string | null } & PageArgs,
      { caller }: Context,
    ) => {
      const page = pageArgs(args, 1, 100);
      const songs = await api.joysoundArtistSongs(
        { id: args.artistId ?? "", ...page },
        caller,
      );
      return toConnection(songs, page, 1, (song) => song);
    },
    joysoundSongsByKeyword: async (
      _: unknown,
      args: { keyword: string | null } & PageArgs,
      { caller }: Context,
    ) => {
      const page = pageArgs(args, 1, 100);
      const songs = await api.joysoundSearchSongs(
        { query: args.keyword ?? "", ...page },
        caller,
      );
      return toConnection(songs, page, 1, (song) => song);
    },
    joysoundArtistsByKeyword: async (
      _: unknown,
      args: { keyword: string | null } & PageArgs,
      { caller }: Context,
    ) => {
      const page = pageArgs(args, 1, 100);
      const artists = await api.joysoundSearchArtists(
        { query: args.keyword ?? "", ...page },
        caller,
      );
      return toConnection(artists, page, 1, (artist) => artist);
    },
    songsByName: async (
      _: unknown,
      args: { name: string | null } & PageArgs,
      { caller }: Context,
    ) => {
      const page = pageArgs(args, 0, 30);
      const songs = await api.damSearchSongs(
        { query: args.name ?? "", ...page },
        caller,
      );
      return toConnection(songs, page, 0, (song) => song);
    },
    songById: (_: unknown, args: { id: string }, { caller }: Context) =>
      api.damSong({ id: args.id }, caller),
    artistsByName: async (
      _: unknown,
      args: { name: string | null } & PageArgs,
      { caller }: Context,
    ) => {
      const page = pageArgs(args, 0, 30);
      const artists = await api.damSearchArtists(
        { query: args.name ?? "", ...page },
        caller,
      );
      return toConnection(artists, page, 0, (artist) => artist);
    },
    artistById: async (
      _: unknown,
      args: { id: string | null } & PageArgs,
      { caller }: Context,
    ): Promise<ArtistParent> => {
      const page = pageArgs(args, 0, 30);
      const artist = await api.damArtist(
        { id: args.id ?? "", ...page },
        caller,
      );
      return { ...artist, songsArgs: page };
    },
    currentSong: () => toGqlItemOrNull(store.getState().currentSong),
    queue: () => store.getState().songQueue.map(toGqlItem),
    config: () => {
      // Every phone can read this, so return only what the schema exposes,
      // never the whole config with its DAM/Joysound/proxy credentials.
      return {
        adminNicks: karafriendsConfig.adminNicks,
        adminDeviceIds: karafriendsConfig.adminDeviceIds,
        supervisedMode: karafriendsConfig.supervisedMode,
        __typename: "KarafriendsConfig",
      };
    },
    songHistory: async (_: unknown, args: PageArgs, { caller }: Context) => {
      const page = pageArgs(args, 0, 30);
      const history = await api.history(page, caller);
      return toConnection(history, page, 0, (song) => ({
        song: toGqlItem(song),
      }));
    },
    youtubeVideoInfo: async (
      _: unknown,
      args: { videoId: string | null },
      { caller }: Context,
    ) => {
      const result = await api.youtubeInfo(
        { videoId: args.videoId ?? "" },
        caller,
      );
      return result.ok
        ? { __typename: "YoutubeVideoInfo", ...result.info }
        : { __typename: "YoutubeVideoInfoError", reason: result.reason };
    },
    nicoVideoInfo: async (
      _: unknown,
      args: { videoId: string | null },
      { caller }: Context,
    ) => {
      const result = await api.nicoInfo(
        { videoId: args.videoId ?? "" },
        caller,
      );
      return result.ok
        ? { __typename: "NicoVideoInfo", ...result.info }
        : { __typename: "NicoVideoInfoError", reason: result.reason };
    },
    pitchShiftSemis: () => store.getState().pitchShiftSemis,
    playbackState: () => store.getState().playbackState,
    videoDownloadProgress: (
      _: unknown,
      args: {
        videoDownloadType: number;
        songId: string;
        suffix: string | null;
      },
    ) => ({
      progress: getVideoDownloadProgress(
        store.getState().downloadQueue,
        args.videoDownloadType,
        args.songId,
        args.suffix,
      ),
    }),
  },
  Mutation: {
    sendEmote: (
      _: unknown,
      args: { emote: { emote: string; userIdentity: UserIdentity } },
      { caller }: Context,
    ) =>
      api.sendEmote(
        { emote: args.emote.emote },
        {
          ...caller,
          deviceId: args.emote.userIdentity.deviceId,
          nickname: args.emote.userIdentity.nickname,
        },
      ),
    queueDamSong: (
      _: unknown,
      args: QueueSongArgs<{ streamingUrlIdx: number }>,
      context: Context,
    ) =>
      queueSong(args, context, (input) => ({
        kind: "dam",
        ...songFields(input),
        streamingUrlIdx: input.streamingUrlIdx,
      })),
    queueJoysoundSong: (
      _: unknown,
      args: QueueSongArgs<{
        isRomaji: boolean;
        youtubeVideoId?: string | null;
      }>,
      context: Context,
    ) =>
      queueSong(args, context, (input) => ({
        kind: "joysound",
        ...songFields(input),
        isRomaji: input.isRomaji,
        youtubeVideoId: input.youtubeVideoId ?? null,
      })),
    queueYoutubeSong: (
      _: unknown,
      args: QueueSongArgs<{
        adhocSongLyrics?: string | null;
        captionCode?: string | null;
        gainValue: number;
      }>,
      context: Context,
    ) =>
      queueSong(args, context, (input) => ({
        kind: "youtube",
        ...songFields(input),
        adhocLyrics: input.adhocSongLyrics ?? null,
        captionCode: input.captionCode ?? null,
        gainValue: input.gainValue,
      })),
    queueNicoSong: (
      _: unknown,
      args: QueueSongArgs<Record<never, never>>,
      context: Context,
    ) =>
      queueSong(args, context, (input) => ({
        kind: "nico",
        ...songFields(input),
      })),
    pushAdhocLyrics: (
      _: unknown,
      args: { input: AdhocLyricsEntry },
      { caller }: Context,
    ) =>
      api.pushAdhocLyrics(
        { lyric: args.input.lyric, lyricIndex: args.input.lyricIndex },
        caller,
      ),
    popSong: async (_: unknown, __: unknown, { caller }: Context) =>
      toGqlItemOrNull(await api.popSong({}, caller)),
    removeSong: (
      _: unknown,
      args: { songId: string; timestamp: string },
      { caller }: Context,
    ) =>
      api.removeSong(
        { songId: args.songId, timestamp: args.timestamp },
        caller,
      ),
    setPitchShiftSemis: (
      _: unknown,
      args: { semis: number },
      { caller }: Context,
    ) => api.setPitchShiftSemis({ semis: args.semis }, caller),
    setPlaybackState: (
      _: unknown,
      args: { playbackState: PlaybackState },
      { caller }: Context,
    ) => api.setPlaybackState({ playbackState: args.playbackState }, caller),
  },
  Subscription: {
    currentSongAdhocLyricsChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.CurrentSongAdhocLyricsChanged,
        ]),
    },
    currentSongChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.CurrentSongChanged]),
    },
    emote: {
      subscribe: () => pubsub.asyncIterableIterator([SubscriptionEvent.Emote]),
    },
    pitchShiftSemisChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.PitchShiftSemisChanged,
        ]),
    },
    playbackStateChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.PlaybackStateChanged]),
    },
    queueAdded: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.QueueAdded]),
    },
    queueChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.QueueChanged]),
    },
  },
};

const schema = makeExecutableSchema({
  typeDefs: rawSchema,
  resolvers,
});

// The caller of a GraphQL request. Filled in from its headers in a later
// change.
function callerOf(): Caller {
  return { deviceId: null, nickname: null };
}

export function applyGraphQLMiddleware(app: Application) {
  const httpServer = createServer(app);

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  // These servers are EventEmitters: an unhandled "error" event (most commonly
  // the remocon port already being in use) would otherwise crash the whole app
  // with a bare stack trace. Fail loudly with a clear message and quit cleanly.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      dialog.showErrorBox(
        "karafriends: port already in use",
        `Port ${karafriendsConfig.remoconPort} is already in use. ` +
          "Is karafriends already running? Close the other instance " +
          "(or free the port) and relaunch.",
      );
    } else {
      console.error("HTTP server error:", err);
    }
    electronApp.quit();
  });
  wsServer.on("error", (err) => {
    console.error("WebSocket server error:", err);
  });

  useServer({ schema }, wsServer);

  const server = new ApolloServer<Context>({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      ApolloServerPluginCacheControlDisabled(),
      ApolloServerPluginInlineTraceDisabled(),
      ApolloServerPluginLandingPageDisabled(),
      ApolloServerPluginSchemaReportingDisabled(),
      ApolloServerPluginUsageReportingDisabled(),
    ],
  });

  if (isDev) {
    app.use("/graphql", (req, res, next) => {
      res.append("Access-Control-Allow-Origin", "*");
      res.append("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
      }
      next();
    });
  }

  server
    .start()
    .then(() => {
      app.use(
        "/graphql",
        express.json(),
        expressMiddleware(server, {
          context: async () => ({
            dataSources: upstreamClients,
            caller: callerOf(),
          }),
        }),
      );
      httpServer.listen(karafriendsConfig.remoconPort, () => {
        console.log(
          `Server is now running on http://localhost:${karafriendsConfig.remoconPort}`,
        );
      });
    })
    .catch((err) => {
      // server.start() rejecting leaves the app with no GraphQL backend, so there
      // is nothing useful to keep running — surface it and quit cleanly.
      console.error("Failed to start the GraphQL server:", err);
      dialog.showErrorBox("karafriends: failed to start", String(err));
      electronApp.quit();
    });
}
