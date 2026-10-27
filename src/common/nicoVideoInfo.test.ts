// This file runs on Node's built-in test runner, not through the app bundle, so
// it uses node: core modules directly.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isNicoVideoId,
  nicoWatchUrl,
  parseNicoVideoInfo,
} from "./nicoVideoInfo.ts";

// Trimmed from `yt-dlp --dump-single-json --skip-download` for sm9
// (yt-dlp 2026.10.26).
const SM9 = {
  id: "sm9",
  title: "新・豪血寺一族 -煩悩解放 - レッツゴー！陰陽師",
  description: "レッツゴー！陰陽師（フルコーラスバージョン）",
  uploader: "中の",
  uploader_id: "4",
  channel: "中の",
  channel_id: "4",
  duration: 320,
  view_count: 23120038,
  thumbnail: "https://goptim.video.nimg.jp/thumbnail/1280x720?i=9",
  thumbnails: [
    { id: "url", url: "https://nicovideo.cdn.nimg.jp/thumbnails/9/9" },
    {
      id: "player",
      url: "https://img.cdn.nimg.jp/s/nicovideo/thumbnails/9/9.original/a960x540l",
    },
    { id: "ogp", url: "https://goptim.video.nimg.jp/thumbnail/1280x720?i=9" },
  ],
};

describe("parseNicoVideoInfo", () => {
  test("maps yt-dlp's fields to the video info", () => {
    assert.deepEqual(parseNicoVideoInfo(JSON.stringify(SM9)), {
      author: "中の",
      channelId: "4",
      description: "レッツゴー！陰陽師（フルコーラスバージョン）",
      lengthSeconds: 320,
      title: "新・豪血寺一族 -煩悩解放 - レッツゴー！陰陽師",
      thumbnailUrl:
        "https://img.cdn.nimg.jp/s/nicovideo/thumbnails/9/9.original/a960x540l",
      viewCount: 23120038,
    });
  });

  test("falls back to the channel and default thumbnail", () => {
    const info = parseNicoVideoInfo(
      JSON.stringify({
        ...SM9,
        uploader: null,
        uploader_id: null,
        channel: "Some Channel",
        channel_id: "ch123",
        thumbnails: [],
      }),
    );
    assert.equal(info.author, "Some Channel");
    assert.equal(info.channelId, "ch123");
    assert.equal(info.thumbnailUrl, SM9.thumbnail);
  });

  test("fills missing optional fields and rounds the duration", () => {
    assert.deepEqual(
      parseNicoVideoInfo(JSON.stringify({ title: "t", duration: 12.6 })),
      {
        author: "",
        channelId: "",
        description: "",
        lengthSeconds: 13,
        title: "t",
        thumbnailUrl: "",
        viewCount: 0,
      },
    );
  });

  test("rejects output without a title", () => {
    assert.throws(() => parseNicoVideoInfo("{}"));
    assert.throws(() => parseNicoVideoInfo("not json"));
  });
});

describe("isNicoVideoId", () => {
  test("accepts Niconico IDs", () => {
    for (const id of ["sm9", "nm2829323", "so38016254", "1340979099"]) {
      assert.equal(isNicoVideoId(id), true, id);
    }
  });

  test("rejects anything else", () => {
    for (const id of ["", "sm", "SM9", "sm9?x", "sm9/..", "-o", "smabc"]) {
      assert.equal(isNicoVideoId(id), false, id);
    }
  });
});

describe("nicoWatchUrl", () => {
  test("builds the watch page URL", () => {
    assert.equal(nicoWatchUrl("sm9"), "https://www.nicovideo.jp/watch/sm9");
  });
});
