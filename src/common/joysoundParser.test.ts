// Runs on Node's test runner through tsx (yarn test:unit). The telops are
// built by tests/fixtures/joy02.ts; the romaji comes from the real kuroshiro
// and kuromoji (the dictionary in node_modules, the same as static/dict).
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import {
  buildJoy02,
  type Joy02Block,
  type Joy02Event,
  joy02Events as at,
} from "../../tests/fixtures/joy02";
import parseJoysoundData, {
  getSongDuration,
  type KuroshiroSingleton,
} from "./joysoundParser";

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function telop(blocks: Joy02Block[], events: Joy02Event[] = []): ArrayBuffer {
  return arrayBuffer(
    buildJoy02({
      title: "テスト曲",
      artist: "テスト歌手",
      lyricist: "作詞者",
      composer: "作曲者",
      seconds: 245,
      blocks,
      events,
    }),
  );
}

// Every block's romaji, as "phrase@x" sorted by x.
function romajiOf(data: Awaited<ReturnType<typeof parseJoysoundData>>) {
  return data.lyrics.map((block) =>
    [...block.romaji]
      .sort((a, b) => a.xPos - b.xPos)
      .map(({ phrase, xPos }) => `${phrase}@${xPos}`),
  );
}

describe("a JOY-02 telop's layout", () => {
  const blocks: Joy02Block[] = [
    {
      x: 120,
      y: 300,
      text: "空港へ",
      width: 40,
      ruby: [{ x: 0, text: "くうこう" }],
      colours: [0, 2, 1, 3],
    },
    { x: 140, y: 380, text: "ABC", width: 22 },
  ];

  test("the names, the playtime and each block's place, colours and ruby", async () => {
    const buffer = buildJoy02({
      title: "テスト曲",
      artist: "テスト歌手",
      lyricist: "作詞者",
      composer: "作曲者",
      seconds: 245,
      blocks,
      events: [],
    });
    assert.equal(getSongDuration(new Uint8Array(buffer)), 245);

    const data = await parseJoysoundData(arrayBuffer(buffer), null);
    assert.deepEqual(data.metadata, {
      musicName: "テスト曲",
      artistName: "テスト歌手",
      lyricistName: "作詞者",
      composerName: "作曲者",
      musicNameReading: "",
      artistNameReading: "",
      fadeoutTime: 0,
    });

    const [first, second] = data.lyrics;
    assert.equal(data.lyrics.length, 2);
    // 14 bytes of header, 5 per glyph, 2 for the ruby count, 4 + 2 per
    // ruby character.
    assert.equal(first.blockSize, 14 + 3 * 5 + 2 + 4 + 4 * 2);
    assert.equal(second.blockSize, 14 + 3 * 5 + 2);
    assert.deepEqual([first.xPos, first.yPos], [120, 300]);
    assert.deepEqual([second.xPos, second.yPos], [140, 380]);
    // RGB555 white, blue, black and pink.
    assert.deepEqual(first.preFill.rgb, [255, 255, 255]);
    assert.deepEqual(first.postFill.rgb, [0, 0, 255]);
    assert.deepEqual(first.preBorder.rgb, [0, 0, 0]);
    assert.deepEqual(first.postBorder.rgb, [255, 82, 255]);
    assert.deepEqual(
      first.chars.map((c) => [c.charCode, c.width]),
      [
        [0x8bf3, 40],
        [0x8d60, 40],
        [0x82d6, 40],
      ],
    );
    assert.deepEqual(
      second.chars.map((c) => c.charCode),
      [0x41, 0x42, 0x43],
    );
    assert.deepEqual(first.furigana, [
      { length: 4, xPos: 0, chars: [0x82ad, 0x82a4, 0x82b1, 0x82a4] },
    ]);
    assert.deepEqual(second.furigana, []);
    // Without kuroshiro (kana mode), no romaji.
    assert.deepEqual(first.romaji, []);
  });
});

describe("a JOY-02 telop's timeline", () => {
  const line = (text: string, flags = 0): Joy02Block => ({
    x: 100,
    y: 300,
    text,
    flags,
  });

  test("fades blocks in and out in order, and gives each wipe to the next block not flagged 0xff", async () => {
    const data = await parseJoysoundData(
      telop(
        [line("あ"), line("◆", 0xff), line("い"), line("う")],
        [
          at.titleOut(3000),
          at.fadeIn(4000, 2),
          at.scroll(5000, 10),
          at.scrollMore(5500, 20),
          at.fadeIn(6000, 2),
          at.scroll(7000, 12),
          at.fadeOut(8000, 3),
          at.scroll(9000, 8),
          at.fadeOut(10000, 1),
        ],
      ),
      null,
    );
    assert.equal(data.metadata.fadeoutTime, 3000);
    assert.deepEqual(
      data.lyrics.map((b) => [b.fadeinTime, b.fadeoutTime]),
      [
        [4000, 8000],
        [4000, 8000],
        [6000, 8000],
        [6000, 10000],
      ],
    );
    assert.deepEqual(
      data.lyrics.map((b) => b.scrollEvents),
      [
        [
          { time: 5000, speed: 100 },
          { time: 5500, speed: 200 },
        ],
        [],
        [{ time: 7000, speed: 120 }],
        [{ time: 9000, speed: 80 }],
      ],
    );
  });

  test("ignores events that point at no block, instead of losing the song's lyrics", async () => {
    const data = await parseJoysoundData(
      telop(
        [line("あ"), line("い")],
        [
          // A wipe change before any wipe started.
          at.scrollMore(1000, 5),
          // A fade-out with nothing on screen.
          at.fadeOut(1500, 1),
          at.fadeIn(2000, 3),
          at.scroll(3000, 10),
          at.scroll(4000, 10),
          at.scroll(5000, 10),
          at.fadeOut(6000, 4),
        ],
      ),
      null,
    );
    assert.deepEqual(
      data.lyrics.map((b) => [b.fadeinTime, b.fadeoutTime]),
      [
        [2000, 6000],
        [2000, 6000],
      ],
    );
    assert.deepEqual(
      data.lyrics.map((b) => b.scrollEvents.map((e) => e.time)),
      [[3000], [4000]],
    );
  });
});

describe("a JOY-02 telop's romaji", () => {
  let kuroshiro: KuroshiroSingleton;

  before(async () => {
    const instance = new Kuroshiro();
    const analyzer = new KuromojiAnalyzer();
    await instance.init(analyzer);
    kuroshiro = { kuroshiro: instance, analyzer };
  });

  // Kana and kanji with ruby (空港, 行), kanji with kana but no ruby (下げる,
  // from kuroshiro's okurigana), kanji alone without ruby (空, from
  // dictionary.json), a full-width space and は read as "wa".
  const lines: Joy02Block[] = [
    {
      x: 100,
      y: 300,
      text: "空港へ行く",
      ruby: [
        { x: 0, text: "くうこう" },
        { x: 132, text: "い" },
      ],
    },
    { x: 100, y: 380, text: "下げる" },
    {
      x: 100,
      y: 300,
      text: "君の　名は",
      ruby: [
        { x: 0, text: "きみ" },
        { x: 132, text: "な" },
      ],
    },
    { x: 100, y: 380, text: "空" },
  ];
  const expected = [
    ["kuukou@0", "e@88", "i@132", "ku@176"],
    ["sa@0", "ge@44", "ru@88"],
    ["kimi@0", "no@44", "na@132", "wa@176"],
    ["sora@0"],
  ];

  test("comes from the ruby, the kana and the readings of kanji without ruby", async () => {
    const data = await parseJoysoundData(telop(lines), kuroshiro);
    assert.deepEqual(romajiOf(data), expected);
  });

  test("a block of only spaces has none, and the other blocks keep theirs", async () => {
    const blank = (text: string): Joy02Block => ({ x: 100, y: 300, text });
    const data = await parseJoysoundData(
      telop([lines[0], blank("　　"), blank("  "), ...lines.slice(1)]),
      kuroshiro,
    );
    assert.deepEqual(romajiOf(data), [
      expected[0],
      [],
      [],
      ...expected.slice(1),
    ]);
    assert.equal(data.lyrics[1].chars.length, 2);
  });
});
