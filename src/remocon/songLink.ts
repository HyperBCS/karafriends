import type { QueueItemKind } from "../common/api";

const SONG_PAGES: Record<QueueItemKind, string> = {
  dam: "/song/",
  joysound: "/joysoundSong/",
  youtube: "/search/youtube/",
  nico: "/search/niconico/",
};

// The remote's page for a queued or sung song.
export default function songLink(song: {
  kind: QueueItemKind;
  songId: string;
}): string {
  return `${SONG_PAGES[song.kind]}${song.songId}`;
}
