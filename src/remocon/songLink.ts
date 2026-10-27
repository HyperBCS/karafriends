import type { QueueItemKind } from "../common/api";
import { t } from "./i18n";

const SONG_PAGES: Record<QueueItemKind, string> = {
  dam: "/song/",
  joysound: "/joysoundSong/",
  youtube: "/search/youtube/",
  nico: "/search/niconico/",
};

const SOURCE_NAMES = {
  dam: "source.dam",
  joysound: "source.joysound",
  youtube: "source.youtube",
  nico: "source.niconico",
} as const;

// The remote's page for a queued or sung song.
export default function songLink(song: {
  kind: QueueItemKind;
  songId: string;
}): string {
  return `${SONG_PAGES[song.kind]}${song.songId}`;
}

// Where a song comes from, as the small label on its row.
export function sourceName(kind: QueueItemKind): string {
  return t(SOURCE_NAMES[kind]);
}
