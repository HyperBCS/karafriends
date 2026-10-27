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
import { Innertube } from "youtubei.js";

import rawSchema from "inline-string:../common/schema.graphql";
import type {
  DamQueueItem,
  JoysoundQueueItem,
  NicoQueueItem,
  PlaybackState,
  QueueItem,
  UserIdentity,
  YoutubeQueueItem,
} from "../common/api";
import karafriendsConfig from "../common/config";
import {
  downloadDamVideo,
  downloadJoysoundData,
  downloadNicoVideo,
  downloadYoutubeVideo,
  getNicoVideoInfo,
  getVideoDownloadProgress,
} from "./../common/videoDownloader";
import { DkwebsysAPI, MinseiAPI } from "./damApi";
import { JoysoundAPI } from "./joysoundApi";
import { store } from "./services";
import type { HistoryItem, State } from "./state";

import "regenerator-runtime/runtime";

export interface IDataSources {
  dataSources: {
    minsei: MinseiAPI;
    joysound: JoysoundAPI;
    dkwebsys: DkwebsysAPI;
  };
}

interface JoysoundSongParent {
  readonly id: string;
  readonly name: string;
  readonly artistName: string;
  readonly lyricsPreview?: string | null;
  readonly tieUp?: string | null;
}

interface JoysoundArtistParent {
  readonly id: string;
  readonly name: string;
}

interface SongParent {
  readonly id: string;
  readonly name: string;
  readonly nameYomi: string;
  readonly artistName: string;
  readonly artistNameYomi: string;
  readonly lyricsPreview?: string | null;
  readonly vocalTypes?: string[];
  readonly tieUp?: string | null;
  readonly playtime?: number | null;
}

interface ArtistParent {
  readonly id: string;
  readonly name: string;
  readonly nameYomi: string;
  readonly songCount: number;
}

interface Connection<NodeType, CursorType> {
  readonly edges: Edge<NodeType, CursorType>[];
  readonly pageInfo: PageInfo<CursorType>;
}

interface Edge<NodeType, CursorType> {
  readonly node: NodeType;
  readonly cursor: CursorType;
}

interface PageInfo<CursorType> {
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly startCursor: CursorType;
  readonly endCursor: CursorType;
}

interface CaptionLanguage {
  code: string;
  name: string;
}

interface VideoInfo {
  readonly author: string;
  readonly channelId: string;
  readonly lengthSeconds: number;
  readonly description: string;
  readonly title: string;
  readonly viewCount: number;
}

interface YoutubeVideoInfo extends VideoInfo {
  readonly __typename: "YoutubeVideoInfo";
  readonly captionLanguages: CaptionLanguage[];
  readonly keywords: string[];
}

interface YoutubeVideoInfoError {
  readonly __typename: "YoutubeVideoInfoError";
  readonly reason: string;
}

type YoutubeVideoInfoResult = YoutubeVideoInfo | YoutubeVideoInfoError;

interface NicoVideoInfo extends VideoInfo {
  readonly __typename: "NicoVideoInfo";
  readonly thumbnailUrl: string;
}

interface NicoVideoInfoError {
  readonly __typename: "NicoVideoInfoError";
  readonly reason: string;
}

type NicoVideoInfoResult = NicoVideoInfo | NicoVideoInfoError;

type QueueSongInfo = {
  readonly __typename: "QueueSongInfo";
  readonly eta: number;
};

interface QueueSongError {
  readonly __typename: "QueueSongError";
  readonly reason: string;
}

type QueueSongResult = QueueSongInfo | QueueSongError;

type Emote = {
  readonly userIdentity: UserIdentity;
  readonly emote: string;
};

type QueueDamSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly streamingUrlIdx: number;
  readonly userIdentity: UserIdentity;
};

type QueueJoysoundSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
  readonly isRomaji: boolean;
  readonly youtubeVideoId: string | null;
};

type QueueYoutubeSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
  readonly adhocSongLyrics: string;
  readonly captionCode: string | null;
  readonly gainValue: number;
};

type QueueNicoSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
};

type PushAdhocLyricsInput = {
  readonly lyric: string;
  readonly lyricIndex: number;
};

interface VideoDownloadProgress {
  progress: number;
}

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

function hasMaxSongsInQueue(userIdentity: UserIdentity): boolean {
  const db = store.getState();
  // Not very efficient, but surely the queue won't ever get so big that this would be considered expensive
  const songsQueuedByUser: number = db.songQueue.filter(
    (x) => x.user.deviceId === userIdentity.deviceId,
  ).length;

  const songsDownloadingByUser: number = db.downloadQueue.filter(
    (x) => x.userIdentity.deviceId === userIdentity.deviceId,
  ).length;

  console.log(
    `hasMaxSongsInQueue: user ${userIdentity.nickname} has ${songsQueuedByUser}, ${songsDownloadingByUser} downloading`,
  );
  console.log(
    `adminNicks=${karafriendsConfig.adminNicks}, adminDeviceIds=${karafriendsConfig.adminDeviceIds}`,
  );

  return (
    !karafriendsConfig.adminNicks.includes(userIdentity.nickname) &&
    !karafriendsConfig.adminDeviceIds.includes(userIdentity.deviceId) &&
    karafriendsConfig.paxSongQueueLimit > 0 &&
    songsQueuedByUser + songsDownloadingByUser >=
      karafriendsConfig.paxSongQueueLimit
  );
}

function canPushToHeadOfQueue(userIdentity: UserIdentity): boolean {
  return (
    karafriendsConfig.adminNicks.includes(userIdentity.nickname) ||
    karafriendsConfig.adminDeviceIds.includes(userIdentity.deviceId)
  );
}

function pushSongToQueue(
  queueItem: QueueItem,
  pushToHead: boolean = false,
): QueueSongResult {
  const eta = store.update((db) => {
    const eta =
      (db.currentSong?.playtime || 0) +
      db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0);

    console.log(
      `pushSongToQueue: pushing ${JSON.stringify(
        queueItem,
      )} with an eta of ${eta}; pushToHead=${pushToHead}`,
    );

    if (pushToHead === true) {
      // To give things time to download, we don't actually push to the front, but the second.
      // Due to :js:, this is OK regardless of the size of db.songQueue
      db.songQueue.splice(1, 0, queueItem);
    } else {
      db.songQueue.push(queueItem);
    }
    return eta;
  });

  pubsub.publish(SubscriptionEvent.QueueAdded, {
    queueAdded: toGqlItem(queueItem),
  });

  return {
    __typename: "QueueSongInfo",
    eta,
  };
}

function cleanupAdhocSongLyrics(lyrics: string): string[] {
  return lyrics.split("\n").filter((entry) => entry.trim() !== "");
}

function queueEta(): number {
  return store
    .getState()
    .songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0);
}

const resolvers = {
  JoysoundSong: {
    id(parent: JoysoundSongParent) {
      return parent.id;
    },
    name(parent: JoysoundSongParent) {
      return parent.name;
    },
    artistName(parent: JoysoundSongParent) {
      return parent.artistName;
    },
  },

  Song: {
    id(parent: SongParent) {
      return parent.id;
    },
    name(parent: SongParent) {
      return parent.name;
    },
    nameYomi(parent: SongParent) {
      return parent.nameYomi;
    },
    artistName(parent: SongParent) {
      return parent.artistName;
    },
    artistNameYomi(parent: SongParent) {
      return parent.artistNameYomi;
    },
    lyricsPreview(parent: SongParent) {
      return parent.lyricsPreview || null;
    },
    vocalTypes(parent: SongParent) {
      return parent.vocalTypes || [];
    },
    tieUp(parent: SongParent) {
      return parent.tieUp || null;
    },
    playtime(parent: SongParent) {
      return parent.playtime || null;
    },
    streamingUrls(parent: SongParent, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei.getMusicStreamingUrls(parent.id).then((data) =>
        data.list.map((info) => ({
          url: karafriendsConfig.useLowBitrateUrl
            ? info.lowBitrateUrl
            : info.highBitrateUrl,
        })),
      );
    },
    scoringData(parent: SongParent, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getScoringData(parent.id)
        .then((data) => Array.from(new Uint8Array(data)));
    },
  },
  Artist: {
    id(parent: ArtistParent) {
      return parent.id;
    },
    name(parent: ArtistParent) {
      return parent.name;
    },
    nameYomi(parent: ArtistParent) {
      return parent.nameYomi;
    },
    songCount(parent: ArtistParent) {
      return parent.songCount;
    },
    songs(
      parent: ArtistParent,
      args: { first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ) {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getMusicListByArtist(parent.id, firstInt, afterInt)
        .then((result) => ({
          edges: result.list.map((song) => ({
            node: {
              id: song.requestNo,
              name: song.title,
              nameYomi: song.titleYomi,
              artistName: song.artist,
              artistNameYomi: song.artistYomi,
            },
            cursor: (firstInt + 1).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: firstInt + afterInt < result.data.totalCount,
            startCursor: "0",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
  },
  DamQueueItem: {
    streamingUrls(parent: DamQueueItem, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getMusicStreamingUrls(parent.songId)
        .then((data) =>
          data.list.map((info) => ({
            url: karafriendsConfig.useLowBitrateUrl
              ? info.lowBitrateUrl
              : info.highBitrateUrl,
          })),
        );
    },
    scoringData(parent: DamQueueItem, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getScoringData(parent.songId)
        .then((data) => Array.from(new Uint8Array(data)));
    },
  },
  Query: {
    adhocLyrics(_: any, args: { id: string }): string[] | null {
      return store.getState().idToAdhocLyrics[args.id] ?? null;
    },
    joysoundSongDetail: (
      _: any,
      args: { id: string },
      { dataSources }: IDataSources,
    ): Promise<JoysoundSongParent> => {
      return dataSources.joysound.getSongDetail(args.id).then((data) => ({
        id: args.id,
        ...data,
      }));
    },
    joysoundSongsByArtist: (
      _: any,
      args: { artistId: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundSongParent, string>> => {
      const firstInt = args.first || 100;
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return dataSources.joysound
        .getSongListByArtist(args.artistId, afterInt, firstInt)
        .then((result) => ({
          edges: result.map((song, i) => ({
            node: {
              id: song.selSongNo,
              name: song.songName,
              artistName: song.artistName,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: "1",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    joysoundSongsByKeyword: (
      _: any,
      args: { keyword: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundSongParent, string>> => {
      const firstInt = args.first || 100;
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return dataSources.joysound
        .getSongListByKeyword(args.keyword, afterInt, firstInt)
        .then((result) => ({
          edges: result.map((song, i) => ({
            node: {
              id: song.selSongNo,
              name: song.songName,
              artistName: song.artistName,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: "1",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    joysoundArtistsByKeyword: (
      _: any,
      args: { keyword: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundArtistParent, string>> => {
      const firstInt = args.first || 100;
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return dataSources.joysound
        .getArtistListByKeyword(args.keyword, afterInt, firstInt)
        .then((result) => ({
          edges: result.map((artist, i) => ({
            node: {
              id: artist.artistId_digi,
              name: artist.artistName,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: "1",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    songsByName: (
      _: any,
      args: { name: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<SongParent, string>> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getMusicByKeyword(args.name, firstInt, afterInt)
        .then((result) => ({
          edges: result.list.map((song, i) => ({
            node: {
              id: song.requestNo,
              name: song.title,
              nameYomi: song.titleYomi,
              artistName: song.artist,
              artistNameYomi: song.artistYomi,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false, // We can always do this because we don't support backward pagination
            hasNextPage: firstInt + afterInt < result.data.totalCount,
            startCursor: "0",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    songById: (
      _: any,
      args: { id: string },
      { dataSources }: IDataSources,
    ): Promise<SongParent> =>
      dataSources.dkwebsys.getMusicDetailsInfo(args.id).then((data) => ({
        id: args.id,
        name: data.data.title,
        nameYomi: data.data.titleYomi_Kana,
        artistName: data.data.artist,
        artistNameYomi: "",
        lyricsPreview: data.data.firstLine,
        vocalTypes: data.list[0].mModelMusicInfoList[0].guideVocal
          .split(",")
          .map((vocalType) => {
            switch (vocalType) {
              case "0":
                return "NORMAL";
              case "1":
                return "GUIDE_MALE";
              case "2":
                return "GUIDE_FEMALE";
              default:
                console.warn(`unknown vocal type ${vocalType}`);
                return "UNKNOWN";
            }
          }),
        tieUp: data.list[0].mModelMusicInfoList[0].highlightTieUp,
        playtime: parseInt(data.list[0].mModelMusicInfoList[0].playtime, 10),
      })),
    artistsByName: (
      _: any,
      args: { name: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<ArtistParent, string>> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getArtistByKeyword(args.name, firstInt, afterInt)
        .then((result) => ({
          edges: result.list.map((artist, i) => ({
            node: {
              id: artist.artistCode.toString(),
              name: artist.artist,
              nameYomi: artist.artistYomi,
              songCount: artist.holdMusicCount,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false, // We can always do this because we don't support backward pagination
            hasNextPage: firstInt + afterInt < result.data.totalCount,
            startCursor: "0",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    artistById: (
      _: any,
      args: { id: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<ArtistParent> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getMusicListByArtist(args.id, firstInt, afterInt)
        .then((data) => ({
          id: args.id,
          name: data.data.artist,
          nameYomi: data.data.artistYomi_Kana,
          songCount: data.data.totalCount,
        }));
    },
    currentSong: () => {
      return toGqlItemOrNull(store.getState().currentSong);
    },
    queue: () => {
      return store.getState().songQueue.map(toGqlItem);
    },
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
    songHistory: (
      _: any,
      args: { first: number | null; after: string | null },
    ) => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;
      const songHistory: HistoryItem[] = store.getState().songHistory;

      // A cursor is the number of items before the next page.
      return {
        edges: songHistory
          .slice(afterInt, afterInt + firstInt)
          .map((songHistoryItem, i) => ({
            node: { song: toGqlItem(songHistoryItem.song) },
            cursor: (afterInt + i + 1).toString(),
          })),
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: firstInt + afterInt < songHistory.length,
          startCursor: "0",
          endCursor: (firstInt + afterInt).toString(),
        },
      };
    },
    youtubeVideoInfo: (
      _: any,
      args: { videoId: string },
    ): Promise<YoutubeVideoInfoResult> => {
      return (
        innertubeApiProvider()
          .then((youtube) => youtube.getBasicInfo(args.videoId))
          // youtubei.js's response is loosely/partially typed and its shape
          // shifts between versions, so treat it as untyped here.
          .then((data: any) => {
            if (data.playability_status?.status !== "OK") {
              return {
                __typename: "YoutubeVideoInfoError",
                reason: data.playability_status?.reason ?? "Unknown",
              };
            }

            const captionTracks = data.captions?.caption_tracks || [];
            const captionLanguages: CaptionLanguage[] = captionTracks
              .filter(
                (captionTrack: any) => !captionTrack.vss_id.startsWith("a"),
              )
              .map((captionTrack: any) => ({
                code: captionTrack.language_code,
                name: captionTrack.name.text ?? "",
              }));

            const loudnessDb =
              data.player_config?.audio_config?.loudness_db || 0.0;

            return {
              __typename: "YoutubeVideoInfo",
              author: data.basic_info.author,
              captionLanguages,
              channelId: data.basic_info.channel_id,
              keywords: data.basic_info.keywords,
              lengthSeconds: data.basic_info.duration,
              description: data.basic_info.short_description,
              title: data.basic_info.title,
              viewCount: data.basic_info.view_count,
              gainValue: 10 ** ((-1 * loudnessDb) / 20),
            };
          })
      );
    },
    nicoVideoInfo: async (
      _: any,
      args: { videoId: string },
    ): Promise<NicoVideoInfoResult> => {
      try {
        return {
          __typename: "NicoVideoInfo",
          ...(await getNicoVideoInfo(args.videoId)),
        };
      } catch (e) {
        console.error(`Failed getting Niconico info for ${args.videoId}:`, e);
        return {
          __typename: "NicoVideoInfoError",
          reason: "Failed getting video info. Maybe an invalid VideoID?",
        };
      }
    },
    pitchShiftSemis: () => store.getState().pitchShiftSemis,
    playbackState: () => store.getState().playbackState,
    videoDownloadProgress: (
      _: any,
      args: {
        videoDownloadType: number;
        songId: string;
        suffix: string | null;
      },
    ): VideoDownloadProgress => {
      const progress = getVideoDownloadProgress(
        store.getState().downloadQueue,
        args.videoDownloadType,
        args.songId,
        args.suffix,
      );

      return { progress };
    },
  },
  Mutation: {
    sendEmote: (_: any, args: { emote: Emote }): boolean => {
      pubsub.publish(SubscriptionEvent.Emote, { emote: args.emote });
      return true;
    },
    queueJoysoundSong: (
      _: any,
      args: { input: QueueJoysoundSongInput; tryHeadOfQueue: boolean },
      { dataSources }: IDataSources,
    ): QueueSongResult => {
      const { userIdentity, ...input } = args.input;
      const queueItem: JoysoundQueueItem = {
        kind: "joysound",
        timestamp: Date.now().toString(),
        ...input,
        playtime: input.playtime ?? null,
        youtubeVideoId: input.youtubeVideoId ?? null,
        user: userIdentity,
      };

      if (hasMaxSongsInQueue(queueItem.user)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.user.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.user);
      console.log(`queueJoysoundSong: pushToHead=${pushToHead}`);

      downloadJoysoundData(
        store.getState().downloadQueue,
        queueItem.user,
        dataSources.joysound,
        queueItem,
        pushToHead,
        pushSongToQueue,
      );

      return {
        __typename: "QueueSongInfo",
        eta: queueEta(),
      };
    },
    queueDamSong: (
      _: any,
      args: { input: QueueDamSongInput; tryHeadOfQueue: boolean },
      { dataSources }: IDataSources,
    ): QueueSongResult => {
      const { userIdentity, ...input } = args.input;
      const queueItem: DamQueueItem = {
        kind: "dam",
        timestamp: Date.now().toString(),
        ...input,
        playtime: input.playtime ?? null,
        user: userIdentity,
      };

      if (hasMaxSongsInQueue(queueItem.user)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.user.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.user);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      console.log(`Starting offline download of ${queueItem.songId}`);
      dataSources.minsei
        .getMusicStreamingUrls(queueItem.songId)
        .then((data) => {
          const selectedIndex = data.list[queueItem.streamingUrlIdx];
          const url = karafriendsConfig.useLowBitrateUrl
            ? selectedIndex.lowBitrateUrl
            : selectedIndex.highBitrateUrl;
          downloadDamVideo(
            url,
            queueItem.songId,
            String(queueItem.streamingUrlIdx),
          );
        });

      return pushSongToQueue(queueItem, pushToHead);
    },
    queueYoutubeSong: (
      _: any,
      args: { input: QueueYoutubeSongInput; tryHeadOfQueue: boolean },
    ): QueueSongResult => {
      const queueItem: YoutubeQueueItem = {
        kind: "youtube",
        songId: args.input.songId,
        name: args.input.name,
        artistName: args.input.artistName,
        playtime: args.input.playtime ?? null,
        timestamp: Date.now().toString(),
        user: args.input.userIdentity,
        hasAdhocLyrics: args.input.adhocSongLyrics ? true : false,
        hasCaptions: args.input.captionCode ? true : false,
        gainValue: args.input.gainValue,
      };

      if (hasMaxSongsInQueue(queueItem.user)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.user.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.user);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      if (args.input.adhocSongLyrics) {
        const lyrics = cleanupAdhocSongLyrics(args.input.adhocSongLyrics);
        store.update((db) => {
          db.idToAdhocLyrics[args.input.songId] = lyrics;
        });
      }

      downloadYoutubeVideo(
        store.getState().downloadQueue,
        queueItem.user,
        args.input.songId,
        args.input.captionCode,
        pushSongToQueue.bind(null, queueItem, pushToHead),
      );

      // The song likely hasn't actually been added to the queue yet since it needs to download,
      // but let's optimistically return the eta assuming it will successfully queue
      return {
        __typename: "QueueSongInfo",
        eta: queueEta() + (args.input.playtime || 0),
      };
    },
    queueNicoSong: (
      _: any,
      args: { input: QueueNicoSongInput; tryHeadOfQueue: boolean },
    ): QueueSongResult => {
      const { userIdentity, ...input } = args.input;
      const queueItem: NicoQueueItem = {
        kind: "nico",
        timestamp: Date.now().toString(),
        ...input,
        playtime: input.playtime ?? null,
        user: userIdentity,
      };

      if (hasMaxSongsInQueue(queueItem.user)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.user.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.user);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      downloadNicoVideo(
        store.getState().downloadQueue,
        queueItem.user,
        args.input.songId,
        pushSongToQueue.bind(null, queueItem, pushToHead),
      );
      // The song likely hasn't actually been added to the queue yet since it needs to download,
      // but let's optimistically return the eta assuming it will successfully queue
      return {
        __typename: "QueueSongInfo",
        eta: queueEta() + (args.input.playtime || 0),
      };
    },
    pushAdhocLyrics: (
      _: any,
      args: { input: PushAdhocLyricsInput },
    ): boolean => {
      store.update((db) => {
        db.currentSongAdhocLyrics.push({
          lyric: args.input.lyric,
          lyricIndex: args.input.lyricIndex,
        });
      });
      return true;
    },
    popSong: () => {
      const newSong = store.update((db) => {
        const newSong = db.songQueue.shift() || null;

        db.currentSongAdhocLyrics = [];

        if (
          db.currentSong &&
          db.currentSong.kind === "youtube" &&
          db.currentSong.hasAdhocLyrics
        ) {
          delete db.idToAdhocLyrics[db.currentSong.songId];
        }

        db.currentSong = newSong;

        if (db.currentSong) {
          const prevSong: QueueItem | null = db.songHistory[0]?.song || null;

          if (
            !prevSong ||
            db.currentSong.kind !== prevSong.kind ||
            db.currentSong.songId !== prevSong.songId ||
            db.currentSong.timestamp !== prevSong.timestamp
          ) {
            db.songHistory.unshift({ song: db.currentSong });
          }
        }
        return newSong;
      });
      return toGqlItemOrNull(newSong);
    },
    removeSong: (
      _: any,
      args: { songId: string; timestamp: string },
    ): boolean => {
      return store.update((db) => {
        const songIdx = db.songQueue.findIndex(
          (item) =>
            item.songId === args.songId && item.timestamp === args.timestamp,
        );
        // The song may already be playing or removed by another phone; without
        // this check, splice(-1, 1) would remove the last song in the queue.
        if (songIdx === -1) return false;
        db.songQueue.splice(songIdx, 1);
        return true;
      });
    },
    setPitchShiftSemis: (_: any, args: { semis: number }): boolean => {
      store.update((db) => {
        db.pitchShiftSemis = args.semis;
      });
      return true;
    },
    setPlaybackState: (
      _: any,
      args: { playbackState: PlaybackState },
    ): boolean => {
      store.update((db) => {
        db.playbackState = args.playbackState;
      });
      return true;
    },
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

export const minseiCredentialsProvider = memoizeSuccess(async () => {
  const { damUsername, damPassword } = karafriendsConfig;
  const minseiLoginResult = await MinseiAPI.login(damUsername, damPassword);
  return {
    userCode: damUsername,
    authToken: minseiLoginResult.data.authToken,
  };
});

export const joysoundCredentialsProvider = memoizeSuccess(async () => {
  const joysoundEmail = encodeURIComponent(karafriendsConfig.joysoundEmail);
  const joysoundPassword = encodeURIComponent(
    karafriendsConfig.joysoundPassword,
  );
  return JoysoundAPI.login(joysoundEmail, joysoundPassword);
});

// The clients keep no per-request state, so every request shares one of each.
const upstreamClients: IDataSources["dataSources"] = {
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

// Only youtubeVideoInfo needs the YouTube client, so it is created on first
// use there rather than awaited in every request's context: a YouTube outage
// then only affects YouTube lookups. memoize would cache a rejected promise
// forever, so use a manual singleton that times out and clears itself on
// failure so the next lookup retries.
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

  const server = new ApolloServer<IDataSources>({
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
          context: async () => ({ dataSources: upstreamClients }),
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
