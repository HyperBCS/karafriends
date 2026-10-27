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

export interface LookupLimits {
  // How many lookups may run at once.
  concurrency: number;
  // How many more may wait for one of those; past that, a lookup fails at
  // once.
  maxWaiting: number;
  // How many results to keep, and for how long.
  cacheSize: number;
  cacheMs: number;
}

// Wraps lookup(id) so each ID is looked up once: calls while it runs share
// its promise, and its result is kept for cacheMs (a failure isn't, so the
// next call tries again). At most `concurrency` lookups run at once.
export function limitLookups<T>(
  lookup: (id: string) => Promise<T>,
  { concurrency, maxWaiting, cacheSize, cacheMs }: LookupLimits,
  now: () => number = Date.now,
): (id: string) => Promise<T> {
  // In insertion order, oldest first. doneAt is null while running.
  const cache = new Map<string, { value: Promise<T>; doneAt: number | null }>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const takeSlot = (): Promise<void> => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    if (waiting.length >= maxWaiting) {
      return Promise.reject(new Error("Too many lookups at once; try again"));
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  // Hands the slot to the next in line, if any.
  const releaseSlot = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return (id) => {
    const hit = cache.get(id);
    if (hit && (hit.doneAt === null || now() - hit.doneAt < cacheMs)) {
      return hit.value;
    }
    cache.delete(id);

    const value = takeSlot().then(async () => {
      try {
        return await lookup(id);
      } finally {
        releaseSlot();
      }
    });
    const entry = { value, doneAt: null as number | null };
    cache.set(id, entry);
    value.then(
      () => {
        entry.doneAt = now();
      },
      () => {
        if (cache.get(id) === entry) cache.delete(id);
      },
    );
    for (const oldest of cache.keys()) {
      if (cache.size <= cacheSize) break;
      cache.delete(oldest);
    }
    return value;
  };
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
