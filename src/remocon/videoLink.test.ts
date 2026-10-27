// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { videoLink } from "./videoLink";

const youtube = (videoId: string) => ({ kind: "youtube", videoId });
const nico = (videoId: string) => ({ kind: "nico", videoId });

describe("videoLink", () => {
  test("finds a YouTube video in a link or an ID", () => {
    for (const text of [
      "jNQXAC9IVRw",
      " jNQXAC9IVRw ",
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://m.youtube.com/watch?v=jNQXAC9IVRw&t=4s",
      "youtube.com/watch?v=jNQXAC9IVRw",
      "https://youtu.be/jNQXAC9IVRw?si=abc",
      "https://www.youtube.com/shorts/jNQXAC9IVRw",
      "https://music.youtube.com/watch?v=jNQXAC9IVRw",
    ]) {
      assert.deepEqual(videoLink(text), youtube("jNQXAC9IVRw"), text);
    }
  });

  test("finds a Niconico video in a link or an ID", () => {
    for (const text of [
      "sm9",
      "https://www.nicovideo.jp/watch/sm9",
      "https://sp.nicovideo.jp/watch/sm9?ref=x",
      "nico.ms/sm9",
    ]) {
      assert.deepEqual(videoLink(text), nico("sm9"), text);
    }
    assert.deepEqual(videoLink("so38016254"), nico("so38016254"));
    assert.deepEqual(videoLink("nm2829323"), nico("nm2829323"));
  });

  test("leaves titles alone", () => {
    for (const text of [
      "",
      "Lemon",
      "Butterflies",
      "SUPERNATURAL",
      "butterflies",
      "夜に駆ける",
      "smile",
      "sm",
      "https://example.com/watch?v=jNQXAC9IVRw",
      "https://www.youtube.com/watch?v=short",
      "https://www.nicovideo.jp/watch/lv123",
    ]) {
      assert.equal(videoLink(text), null, text);
    }
  });
});
