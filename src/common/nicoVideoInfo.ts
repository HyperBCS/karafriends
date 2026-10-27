// Pure helpers for Niconico video info from yt-dlp. They have no electron or
// filesystem dependencies so they can be unit tested directly.

export interface NicoVideoMetadata {
  author: string;
  channelId: string;
  description: string;
  lengthSeconds: number;
  title: string;
  thumbnailUrl: string;
  viewCount: number;
}

// The fields we read from `yt-dlp --dump-single-json` for a Niconico video.
interface YtDlpNicoInfo {
  title?: string;
  uploader?: string | null;
  uploader_id?: string | null;
  channel?: string | null;
  channel_id?: string | null;
  description?: string | null;
  duration?: number | null;
  view_count?: number | null;
  thumbnail?: string | null;
  thumbnails?: { id?: string; url?: string }[] | null;
}

// Same ID shape yt-dlp's Niconico extractor accepts: an optional two-letter
// prefix (sm, nm, so, ...) followed by digits.
const NICO_VIDEO_ID_RE = /^(?:[a-z]{2})?\d+$/;

export function isNicoVideoId(videoId: string): boolean {
  return NICO_VIDEO_ID_RE.test(videoId);
}

export function nicoWatchUrl(videoId: string): string {
  return `https://www.nicovideo.jp/watch/${videoId}`;
}

export function parseNicoVideoInfo(ytDlpJson: string): NicoVideoMetadata {
  const info: YtDlpNicoInfo = JSON.parse(ytDlpJson);
  if (typeof info.title !== "string") {
    throw new Error("yt-dlp returned no title");
  }

  // Prefer the 960x540 "player" thumbnail, which is what the remocon showed
  // before; yt-dlp's default `thumbnail` is a larger, blurred OGP image.
  const playerThumbnail = info.thumbnails?.find((t) => t.id === "player");

  return {
    author: info.uploader ?? info.channel ?? "",
    channelId: info.uploader_id ?? info.channel_id ?? "",
    description: info.description ?? "",
    lengthSeconds: Math.round(info.duration ?? 0),
    title: info.title,
    thumbnailUrl: playerThumbnail?.url ?? info.thumbnail ?? "",
    viewCount: info.view_count ?? 0,
  };
}
