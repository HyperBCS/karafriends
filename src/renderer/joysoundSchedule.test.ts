// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildJoy02,
  type Joy02Event,
  joy02Events as at,
} from "../../tests/fixtures/joy02";
import parseJoysoundData from "../common/joysoundParser";
import {
  blockOnScreen,
  blockTexturesWanted,
  PITCH_BAND_BOTTOM,
  TEXTURE_LEAD_MS,
  titleCardTop,
  titleOnScreen,
  wipeEdgePx,
} from "./joysoundSchedule";

// A 60-line song as Joysound lays them out: two lines on screen, the top
// one wiped, then replaced by the next while the bottom one is wiped, 4 s a
// line, after an 8 s title card. Two more lines never fade in.
async function sixtyLineSong() {
  const events: Joy02Event[] = [at.titleOut(8000), at.fadeIn(9000, 2)];
  for (let line = 0; line < 60; line++) {
    const start = 10000 + line * 4000;
    events.push(at.scroll(start, 10));
    if (line >= 1 && line < 59) {
      events.push(at.fadeOut(start, 1), at.fadeIn(start, 1));
    }
  }
  events.push(at.fadeOut(10000 + 60 * 4000, 2));
  events.sort((a, b) => a.time - b.time);
  const blocks = Array.from({ length: 62 }, (_, i) => ({
    x: 100,
    y: i % 2 ? 380 : 300,
    text: "あいうえおかきくけこ",
  }));
  const telop = buildJoy02({
    title: "60行",
    artist: "テスト",
    seconds: 260,
    blocks,
    events,
  });
  const buffer = telop.buffer.slice(
    telop.byteOffset,
    telop.byteOffset + telop.byteLength,
  ) as ArrayBuffer;
  return parseJoysoundData(buffer, null);
}

describe("which lyric blocks hold textures", () => {
  test("a 60-line song holds at most four at once, each from before it fades in until it fades out", async () => {
    const { metadata, lyrics } = await sixtyLineSong();
    let most = 0;
    // Every frame at 60 Hz, from before the start (the display draws 200 ms
    // early) to after the end.
    for (let time = -200; time < 260_000; time += 1000 / 60) {
      const wanted = lyrics.filter((block) => blockTexturesWanted(block, time));
      most = Math.max(most, wanted.length);
      for (const block of lyrics) {
        if (blockOnScreen(block, time)) {
          assert.ok(blockTexturesWanted(block, time), `at ${time} ms`);
        }
      }
      assert.equal(titleOnScreen(metadata, time), time < 8000);
    }
    assert.ok(most <= 4, `${most} blocks at once`);
    assert.ok(most >= 2);

    // A block is made a second ahead, and let go as it fades out.
    const third = lyrics[2];
    assert.equal(third.fadeinTime, 14000);
    assert.equal(third.fadeoutTime, 22000);
    assert.equal(
      blockTexturesWanted(third, 14000 - TEXTURE_LEAD_MS - 1),
      false,
    );
    assert.equal(blockTexturesWanted(third, 14000 - TEXTURE_LEAD_MS), true);
    assert.equal(blockTexturesWanted(third, 21999), true);
    assert.equal(blockTexturesWanted(third, 22000), false);
    // The two the timeline never shows: never.
    for (const block of lyrics.slice(60)) {
      assert.equal(block.fadeinTime, -1);
      assert.equal(blockTexturesWanted(block, -500), false);
      assert.equal(blockTexturesWanted(block, 0), false);
    }
  });
});

describe("the wipe's edge", () => {
  test("moves by whole device pixels, not whole telop units", async () => {
    const { lyrics } = await sixtyLineSong();
    const block = lyrics[0];
    // 1080p: 1920 / 720 px to a unit. The wipe runs at 100 units a second,
    // 4.44 px a 60 Hz frame: each frame moves 4 or 5 px, never 2.7 or 5.3
    // (a unit's steps).
    const expandX = 1920 / 720;
    const steps = new Set<number>();
    let last = wipeEdgePx(block, 10000, expandX);
    for (let frame = 1; frame < 120; frame++) {
      const edge = wipeEdgePx(block, 10000 + (frame * 1000) / 60, expandX);
      steps.add(edge - last);
      last = edge;
    }
    assert.deepEqual([...steps].sort(), [4, 5]);
    assert.equal(wipeEdgePx(block, 10000, expandX), Math.floor(100 * expandX));
  });
});

describe("the title card", () => {
  const height = 480;
  const padding = 16;

  test("is centred without the pitch bars", () => {
    assert.equal(titleCardTop(height, 282, padding, false), 83);
  });

  test("starts below the pitch bars' band with them, as far as it fits", () => {
    const top = titleCardTop(height, 200, padding, true);
    assert.equal(top, height * PITCH_BAND_BOTTOM);
    // A taller card goes as low as it fits above the bottom edge.
    const tall = titleCardTop(height, 282, padding, true);
    assert.equal(tall, height - 282 - padding * 2);
    assert.ok(tall > titleCardTop(height, 282, padding, false));
    // One too tall to fit on the screen at all stays centred.
    assert.equal(
      titleCardTop(height, 460, padding, true),
      titleCardTop(height, 460, padding, false),
    );
  });
});
