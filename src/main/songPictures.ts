// The pictures on the phone's song pages, through the karaoke PC: DAM's
// karaoke video title card (its URL needs DAM's app key) and Joysound's
// album art (from Amazon or Apple). Phones only ever talk to karafriends:
//
//   GET /api/songPicture/<dam|joysound|joysoundFeature>/<id>
//                                             the picture, or 404 if the song
//                                             has none, 502 if it couldn't
//                                             be fetched.
//
// A song's picture URL comes from its details: the song page's lookup
// leaves it here (remember), or the route looks the song up itself. The
// pictures are kept in memory, the most recently used first, up to
// MAX_BYTES; phones keep them a day.
//
// No Electron imports, so unit tests can load this file under plain Node.
import express, { type Router } from "express";

import { httpFetch, HttpStatusError, withUrlHidden } from "./http";

// joysoundFeature: one of Joysound's featured lists (Browse).
export type PictureKind = "dam" | "joysound" | "joysoundFeature";

export interface SongPicture {
  contentType: string;
  data: Buffer;
}

export interface SongPicturesDeps {
  // The picture's URL from the song's details, or null if it has none.
  lookUp(kind: PictureKind, id: string): Promise<string | null>;
  maxBytes?: number;
}

export interface SongPictures {
  // From the song page's lookup: the song's picture URL, or null.
  remember(kind: PictureKind, id: string, url: string | null): void;
  // The song's picture, or null if it has none.
  get(kind: PictureKind, id: string): Promise<SongPicture | null>;
}

// 20 MB: a DAM title card is a PNG of about 0.5 MB, album art 50 KB.
const MAX_BYTES = 20 * 1024 * 1024;
// The most a picture may be.
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
// How many songs' picture URLs are kept.
const MAX_SOURCES = 2000;

// The hosts pictures may come from: DAM's catalogue, Amazon's and Apple's
// image servers. https only.
const ALLOWED_HOSTS = [
  /^csgw\.clubdam\.com$/,
  /(^|\.)media-amazon\.com$/,
  /(^|\.)ssl-images-amazon\.com$/,
  /(^|\.)mzstatic\.com$/,
  // Where sound-cafe keeps its featured lists' pictures.
  /^d24lvzvt5ynxi0\.cloudfront\.net$/,
];

export function isAllowedPictureUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    ALLOWED_HOSTS.some((host) => host.test(parsed.hostname))
  );
}

// A DAM request number (3246-51), a Joysound song number (425691), or a
// Joysound featured list's id (63).
const SONG_IDS: Record<PictureKind, RegExp> = {
  dam: /^\d{4}-\d{2}$/,
  joysound: /^\d+$/,
  joysoundFeature: /^\d+$/,
};

export function isPictureKind(kind: string): kind is PictureKind {
  return Object.hasOwn(SONG_IDS, kind);
}

export function isSongId(kind: PictureKind, id: string): boolean {
  return SONG_IDS[kind].test(id);
}

// Fetches url, an image of at most MAX_PICTURE_BYTES. Its errors don't name
// it: DAM's carries the app key.
export async function fetchPicture(url: string): Promise<SongPicture> {
  const what = "the song's picture";
  return withUrlHidden(url, what, async () => {
    const resp = await httpFetch(url, {
      headers: { "User-Agent": "karafriends" },
      timeoutMs: 15_000,
    });
    const contentType = resp.headers.get("Content-Type") ?? "";
    const length = Number(resp.headers.get("Content-Length") ?? 0);
    if (!resp.ok || !contentType.startsWith("image/")) {
      await resp.arrayBuffer().catch(() => undefined);
      throw resp.ok
        ? new Error(`${what} isn't an image (${contentType || "no type"})`)
        : new HttpStatusError(resp.status, what);
    }
    if (length > MAX_PICTURE_BYTES) {
      await resp.arrayBuffer().catch(() => undefined);
      throw new Error(`${what} is too big (${length} bytes)`);
    }
    const data = Buffer.from(await resp.arrayBuffer());
    if (data.length > MAX_PICTURE_BYTES) {
      throw new Error(`${what} is too big (${data.length} bytes)`);
    }
    return { contentType, data };
  });
}

export function createSongPictures(
  deps: SongPicturesDeps & {
    fetch?: (url: string) => Promise<SongPicture>;
  },
): SongPictures {
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const fetch = deps.fetch ?? fetchPicture;
  // Picture URLs (null: none), and the pictures, the least recently used
  // first (a Map keeps its insertion order).
  const sources = new Map<string, string | null>();
  const pictures = new Map<string, SongPicture>();
  let bytes = 0;
  // Fetches under way, so two phones on one song fetch it once.
  const fetching = new Map<string, Promise<SongPicture | null>>();

  const keep = (key: string, picture: SongPicture) => {
    if (picture.data.length > maxBytes) return;
    pictures.set(key, picture);
    bytes += picture.data.length;
    for (const [oldKey, old] of pictures) {
      if (bytes <= maxBytes) break;
      pictures.delete(oldKey);
      bytes -= old.data.length;
    }
  };

  const remember = (kind: PictureKind, id: string, url: string | null) => {
    const key = `${kind}:${id}`;
    sources.delete(key);
    sources.set(key, url !== null && isAllowedPictureUrl(url) ? url : null);
    for (const oldKey of sources.keys()) {
      if (sources.size <= MAX_SOURCES) break;
      sources.delete(oldKey);
    }
  };

  const load = async (
    kind: PictureKind,
    id: string,
    key: string,
  ): Promise<SongPicture | null> => {
    if (!sources.has(key)) remember(kind, id, await deps.lookUp(kind, id));
    const url = sources.get(key);
    if (!url) return null;
    const picture = await fetch(url);
    keep(key, picture);
    return picture;
  };

  return {
    remember,

    get(kind, id) {
      const key = `${kind}:${id}`;
      const kept = pictures.get(key);
      if (kept) {
        // Now the most recently used.
        pictures.delete(key);
        pictures.set(key, kept);
        return Promise.resolve(kept);
      }
      let under = fetching.get(key);
      if (!under) {
        under = load(kind, id, key).finally(() => fetching.delete(key));
        fetching.set(key, under);
      }
      return under;
    },
  };
}

// GET /:kind/:id, for /api/songPicture.
export function songPictureRouter(pictures: SongPictures): Router {
  const router = express.Router();
  router.get("/:kind/:id", async (req, res) => {
    const { kind, id } = req.params;
    if (!isPictureKind(kind) || !isSongId(kind, id)) {
      res.status(400).json({ error: "Not a DAM or Joysound song" });
      return;
    }
    let picture: SongPicture | null;
    try {
      picture = await pictures.get(kind, id);
    } catch (err) {
      // No such song, or no login for its catalogue (a NoLoginError's 409):
      // no picture.
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        res.status(404).json({ error: "The song has no picture" });
        return;
      }
      console.warn(
        `No picture for ${kind} ${id}:`,
        (err as Error)?.message ?? err,
      );
      res.status(502).json({ error: "Couldn't get the song's picture" });
      return;
    }
    if (!picture) {
      res.status(404).json({ error: "The song has no picture" });
      return;
    }
    res
      .status(200)
      .set({
        "Content-Type": picture.contentType,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      })
      .send(picture.data);
  });
  return router;
}
