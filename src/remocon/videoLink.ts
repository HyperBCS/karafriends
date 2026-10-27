// What the search box makes of a pasted YouTube or Niconico link or video
// ID: the video to open, or null for anything else (a song title to search
// for).

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
// An 11-letter word ("Butterflies", "SUPERNATURAL") is a title, not an ID.
const WORD = /^[A-Z]?[a-z]+$|^[A-Z]+$/;
const NICONICO_ID = /^(sm|nm|so)\d+$/;

export type VideoLink = { kind: "youtube" | "nico"; videoId: string };

function asUrl(text: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

// A YouTube video's ID, from a link (youtube.com/watch?v=, youtu.be/,
// /shorts/, /live/, /embed/) or the ID itself.
export function youtubeVideoId(text: string): string | null {
  const trimmed = text.trim();
  if (YOUTUBE_ID.test(trimmed) && !WORD.test(trimmed)) return trimmed;
  // Not a bare word: "lemon" would parse as https://lemon/.
  if (!trimmed.includes(".")) return null;
  const url = asUrl(trimmed);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1);
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id =
      url.searchParams.get("v") ??
      url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ??
      null;
  }
  return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

export function niconicoVideoId(text: string): string | null {
  const trimmed = text.trim();
  if (NICONICO_ID.test(trimmed)) return trimmed;
  if (!trimmed.includes(".")) return null;
  const url = asUrl(trimmed);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|sp|embed)\./, "");
  const id =
    host === "nicovideo.jp"
      ? url.pathname.match(/^\/watch\/([^/]+)/)?.[1]
      : host === "nico.ms"
        ? url.pathname.slice(1)
        : undefined;
  return id !== undefined && NICONICO_ID.test(id) ? id : null;
}

export function videoLink(text: string): VideoLink | null {
  const youtube = youtubeVideoId(text);
  if (youtube) return { kind: "youtube", videoId: youtube };
  const nico = niconicoVideoId(text);
  if (nico) return { kind: "nico", videoId: nico };
  return null;
}
