import type { QueueItemKind } from "../common/api";
import { t } from "./i18n";

// The remote's pages for a song, a video and an artist, by kind: App.tsx's
// routes and every link to them, so a renamed page can't leave a link
// behind (which would land on the search screen, through the "*" route).
export const SONG_PAGES = {
  dam: "/song",
  joysound: "/joysoundSong",
  youtube: "/search/youtube",
  nico: "/search/niconico",
} as const satisfies Record<QueueItemKind, string>;

export const ARTIST_PAGES = {
  dam: "/artist",
  joysound: "/joysoundArtist",
} as const;

const SOURCE_NAMES = {
  dam: "source.dam",
  joysound: "source.joysound",
  youtube: "source.youtube",
  nico: "source.niconico",
} as const satisfies Record<QueueItemKind, string>;

// The remote's page for a song, queued, sung or found. A Joysound song's
// background video goes along, so queueing it again from History or Now
// playing keeps it.
export default function songLink(song: {
  kind: QueueItemKind;
  songId: string;
  youtubeVideoId?: string | null;
}): string {
  const page = `${SONG_PAGES[song.kind]}/${encodeURIComponent(song.songId)}`;
  return song.kind === "joysound" && song.youtubeVideoId
    ? `${page}/${encodeURIComponent(song.youtubeVideoId)}`
    : page;
}

// A DAM or Joysound artist's page.
export function artistLink(kind: "dam" | "joysound", id: string): string {
  return `${ARTIST_PAGES[kind]}/${encodeURIComponent(id)}`;
}

// Where a song comes from, as the small label on its row.
export function sourceName(kind: QueueItemKind): string {
  return t(SOURCE_NAMES[kind]);
}
