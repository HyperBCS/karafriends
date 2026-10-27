// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ApiError } from "../main/api";
import { validators } from "../main/validate";
import { isCaptionCode } from "./captionCode";

// Codes youtubei.js reported for one video's manual captions (2026-10), plus
// script subtags YouTube uses elsewhere.
const YOUTUBE_CODES = [
  "en",
  "ja",
  "iw",
  "fil",
  "ckb",
  "mfe",
  "zh-CN",
  "zh-TW",
  "fr-CA",
  "pt-BR",
  "pt-PT",
  "zh-Hans",
  "zh-Hant",
  "es-419",
  "sr-Latn",
];

const BAD_CODES = [
  "",
  "e",
  "-en",
  "en-",
  "en_US",
  ".*",
  "en|ja",
  "all",
  "en,ja",
  "../en",
  "en.vtt",
  "zh-Hant-x-very-long",
];

describe("isCaptionCode", () => {
  test("accepts YouTube's codes, region and script subtags included", () => {
    for (const code of YOUTUBE_CODES) assert.ok(isCaptionCode(code), code);
  });

  test("refuses what could steer yt-dlp or the file name", () => {
    for (const code of BAD_CODES) assert.ok(!isCaptionCode(code), code);
  });
});

describe("queueSong's captionCode", () => {
  const song = {
    kind: "youtube",
    songId: "iG9CE55wbtY",
    name: "Song",
    artistName: "Artist",
    playtime: 60,
    gainValue: 1,
  };

  test("takes a code with a region or script", () => {
    for (const captionCode of [...YOUTUBE_CODES, null]) {
      assert.equal(
        (
          validators.queueSong({ ...song, captionCode }) as {
            captionCode: string;
          }
        ).captionCode,
        captionCode,
      );
    }
  });

  test("answers a bad code with a 400 instead of a silent no-op", () => {
    for (const captionCode of BAD_CODES) {
      assert.throws(
        () => validators.queueSong({ ...song, captionCode }),
        (err) => err instanceof ApiError && err.status === 400,
        captionCode,
      );
    }
  });
});
