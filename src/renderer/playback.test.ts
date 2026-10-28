// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PoppedDamSong, PoppedSong } from "../common/api";
import {
  AV_OFFSETS,
  UI_SCALES,
  audioDelay,
  drawTime,
  lowBitrateFallback,
  pitchTime,
  savedChoice,
  songGain,
} from "./playback";

describe("the display's settings", () => {
  test("offsets run from -300 to +300 ms in tens, scales 50% to 200%", () => {
    assert.equal(AV_OFFSETS[0], -300);
    assert.equal(AV_OFFSETS.at(-1), 300);
    assert.ok(AV_OFFSETS.includes(0));
    assert.equal(AV_OFFSETS.length, 61);
    assert.deepEqual([UI_SCALES[0], UI_SCALES.at(-1)], [50, 200]);
    assert.ok(UI_SCALES.includes(100));
  });

  test("a saved value is used only if it's one of the choices", () => {
    assert.equal(savedChoice("-40", AV_OFFSETS, 0), -40);
    assert.equal(savedChoice("0", AV_OFFSETS, 10), 0);
    assert.equal(savedChoice(null, AV_OFFSETS, 0), 0);
    assert.equal(savedChoice("", UI_SCALES, 100), 100);
    assert.equal(savedChoice("45", UI_SCALES, 100), 100);
    assert.equal(savedChoice("nonsense", UI_SCALES, 100), 100);
    assert.equal(savedChoice("150", UI_SCALES, 100), 150);
  });
});

describe("the audio/video offset", () => {
  test("positive delays the sound and leaves the drawing on the video", () => {
    assert.equal(audioDelay(120), 0.12);
    assert.equal(drawTime(10, 120), 10);
  });

  test("negative draws behind the video and leaves the sound alone", () => {
    assert.equal(audioDelay(-200), 0);
    assert.equal(drawTime(10, -200), 9.8);
  });

  test("zero changes nothing", () => {
    assert.equal(audioDelay(0), 0);
    assert.equal(drawTime(10, 0), 10);
  });

  test("the mic's pitch is filed at the song's time the singer hears", () => {
    assert.equal(pitchTime(10, 200), 9.8);
    assert.equal(pitchTime(10, -200), 9.8);
    assert.equal(pitchTime(10, 0), 10);
  });
});

describe("lowBitrateFallback", () => {
  const song = (startWithLowBitrate: boolean): PoppedDamSong => ({
    kind: "dam",
    songId: "1234-56",
    name: "千本桜",
    artistName: "黒うさP",
    playtime: 245,
    timestamp: "1",
    user: { deviceId: "d", nickname: "Ken" },
    streamingUrlIdx: 1,
    streamingUrls: [
      { high: "https://dam/0/high.m3u8", low: "https://dam/0/low.m3u8" },
      { high: "https://dam/1/high.m3u8", low: "https://dam/1/low.m3u8" },
    ],
    startWithLowBitrate,
    scoringData: [],
  });

  test("switches on the third stall, to the same vocal type", () => {
    assert.equal(lowBitrateFallback(song(false), 1), null);
    assert.equal(lowBitrateFallback(song(false), 2), null);
    assert.equal(lowBitrateFallback(song(false), 3), "https://dam/1/low.m3u8");
  });

  test("only once: later stalls stay where it is", () => {
    assert.equal(lowBitrateFallback(song(false), 4), null);
    assert.equal(lowBitrateFallback(song(false), 9), null);
  });

  test("a song that started on the low bitrate stays on it", () => {
    assert.equal(lowBitrateFallback(song(true), 3), null);
  });

  test("no URL for the vocal type, no switch", () => {
    assert.equal(
      lowBitrateFallback({ ...song(false), streamingUrls: [] }, 3),
      null,
    );
  });
});

describe("songGain", () => {
  const base = {
    songId: "x",
    name: "Song",
    artistName: "Artist",
    playtime: 200,
    timestamp: "1",
    user: { deviceId: "d", nickname: "Ken" },
  };

  test("every kind has its own, whatever played before", () => {
    const dam: PoppedSong = {
      ...base,
      kind: "dam",
      streamingUrlIdx: 0,
      streamingUrls: [],
      startWithLowBitrate: false,
      scoringData: [],
    };
    const joysound: PoppedSong = {
      ...base,
      kind: "joysound",
      lyricsMode: "kana",
      youtubeVideoId: null,
    };
    assert.equal(songGain(dam), 1);
    assert.equal(songGain(joysound), 1);
    assert.equal(songGain({ ...base, kind: "nico" }), 0.8);
  });

  test("a YouTube song's comes with it", () => {
    const youtube: PoppedSong = {
      ...base,
      kind: "youtube",
      hasAdhocLyrics: false,
      hasCaptions: false,
      gainValue: 3.16,
    };
    assert.equal(songGain(youtube), 3.16);
  });
});
