// This file runs on Node's built-in test runner, not through the app bundle, so
// it uses node: core modules directly.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isNicoVideoId,
  limitLookups,
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

describe("limitLookups", () => {
  // A lookup the test finishes by hand, recording each call.
  function fakeLookup() {
    const calls: string[] = [];
    const pending = new Map<
      string,
      { resolve: (v: string) => void; reject: (e: Error) => void }
    >();
    const lookup = (id: string) => {
      calls.push(id);
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };
    return { calls, pending, lookup };
  }

  const LIMITS = { concurrency: 2, maxWaiting: 2, cacheSize: 3, cacheMs: 1000 };
  // Lets settled promises run their callbacks.
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test("shares one lookup among callers, then keeps the result", async () => {
    let time = 0;
    const { calls, pending, lookup } = fakeLookup();
    const get = limitLookups(lookup, LIMITS, () => time);

    const first = get("sm9");
    const second = get("sm9");
    await tick();
    pending.get("sm9")!.resolve("info");
    assert.deepEqual(await Promise.all([first, second]), ["info", "info"]);

    time = 999;
    assert.equal(await get("sm9"), "info");
    assert.deepEqual(calls, ["sm9"]);

    // Stale after cacheMs.
    time = 1000;
    const third = get("sm9");
    await tick();
    assert.deepEqual(calls, ["sm9", "sm9"]);
    pending.get("sm9")!.resolve("newer");
    assert.equal(await third, "newer");
  });

  test("doesn't keep a failure", async () => {
    const { calls, pending, lookup } = fakeLookup();
    const get = limitLookups(lookup, LIMITS);

    const failed = get("sm1");
    await tick();
    pending.get("sm1")!.reject(new Error("no such video"));
    await assert.rejects(failed, /no such video/);

    const retried = get("sm1");
    await tick();
    pending.get("sm1")!.resolve("info");
    assert.equal(await retried, "info");
    assert.deepEqual(calls, ["sm1", "sm1"]);
  });

  test("runs two at a time, queues two, and refuses more", async () => {
    const { calls, pending, lookup } = fakeLookup();
    const get = limitLookups(lookup, LIMITS);

    const results = ["sm1", "sm2", "sm3", "sm4"].map(get);
    await assert.rejects(get("sm5"), /Too many lookups/);
    await tick();
    assert.deepEqual(calls, ["sm1", "sm2"]);

    // Each one that finishes lets the next waiting one start.
    pending.get("sm1")!.resolve("1");
    await tick();
    assert.deepEqual(calls, ["sm1", "sm2", "sm3"]);
    pending.get("sm2")!.reject(new Error("gone"));
    await tick();
    assert.deepEqual(calls, ["sm1", "sm2", "sm3", "sm4"]);

    // With two running and none waiting, two more may wait.
    const waiting = [get("sm6"), get("sm7")];
    await assert.rejects(get("sm8"), /Too many lookups/);
    pending.get("sm3")!.resolve("3");
    pending.get("sm4")!.resolve("4");
    await tick();
    pending.get("sm6")!.resolve("6");
    pending.get("sm7")!.resolve("7");

    assert.deepEqual(
      await Promise.allSettled([...results, ...waiting]).then((all) =>
        all.map((r) => (r.status === "fulfilled" ? r.value : "failed")),
      ),
      ["1", "failed", "3", "4", "6", "7"],
    );
    assert.deepEqual(calls, ["sm1", "sm2", "sm3", "sm4", "sm6", "sm7"]);
  });

  test("keeps only the newest cacheSize results", async () => {
    const calls: string[] = [];
    const get = limitLookups(async (id) => {
      calls.push(id);
      return id;
    }, LIMITS);

    for (const id of ["sm1", "sm2", "sm3", "sm4"]) await get(id);
    // sm1 was dropped for sm4; sm2-sm4 are still kept.
    for (const id of ["sm2", "sm3", "sm4", "sm1"]) await get(id);
    assert.deepEqual(calls, ["sm1", "sm2", "sm3", "sm4", "sm1"]);
  });
});
