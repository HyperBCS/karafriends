// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { pickReadings, reading } from "./readings";

describe("reading", () => {
  test("as written shows the name", () => {
    assert.equal(reading("恋", "コイ", "written"), null);
  });

  test("gives DAM's kana, or the kana in romaji", () => {
    assert.equal(reading("恋", "こい", "kana"), "こい");
    assert.equal(reading("恋", "こい", "romaji"), "koi");
    assert.equal(reading("星野 源", "ほしのげん", "romaji"), "hoshinogen");
  });

  test("the kana are hiragana, whichever DAM gives", () => {
    assert.equal(reading("恋", "コイ", "kana"), "こい");
    assert.equal(reading("恋", "コイ", "romaji"), "koi");
    assert.equal(reading("恋愛", "レンアイ", "kana"), "れんあい");
    assert.equal(
      reading("小さな恋のうた", "ちいさなこいのうた", "kana"),
      "ちいさなこいのうた",
    );
    assert.equal(reading("愛ラーメン", "アイラーメン", "kana"), "あいらーめん");
  });

  test("a long vowel mark doubles the vowel in romaji", () => {
    assert.equal(
      reading("恋人がサンタクロース", "こいびとがさんたくろーす", "romaji"),
      "koibitogasantakuroosu",
    );
  });

  test("a song with no reading, such as Joysound's, is just its title", () => {
    for (const mode of ["kana", "romaji"] as const) {
      assert.equal(reading("恋", undefined, mode), null);
      assert.equal(reading("恋", "", mode), null);
    }
  });

  test("a name in Latin letters needs no reading", () => {
    assert.equal(reading("Lemon", "レモン", "kana"), null);
    assert.equal(reading("ＬＥＭＯＮ", "レモン", "romaji"), null);
  });

  test("Latin letters with accents, symbols, curly quotes or Unicode hyphens are still as written", () => {
    assert.equal(reading("Café", "カフェ", "romaji"), null);
    assert.equal(reading("Pokémon", "ポケモン", "kana"), null);
    assert.equal(reading("LOVE☆", "ラブ", "romaji"), null);
    assert.equal(reading("LOVE♡", "ラブ", "kana"), null);
    assert.equal(reading("Don\u2019t", "ドント", "kana"), null);
    assert.equal(reading("\u201cHello\u201d", "ハロー", "kana"), null);
    assert.equal(
      reading(
        "Bling\u2010Bang\u2010Bang\u2010Born",
        "ブリンバンバンボン",
        "romaji",
      ),
      null,
    );
    assert.equal(reading("→Pia-no-jaC←", "ピアノジャック", "kana"), null);
    assert.equal(reading("L'Arc～en～Ciel", "ラルクアンシエル", "kana"), null);
  });

  test("a name with any kana or kanji gets its reading", () => {
    assert.equal(reading("Café恋", "カフェコイ", "kana"), "かふぇこい");
    assert.equal(
      reading("LOVEマシーン", "ラブマシーン", "romaji"),
      "rabumashiin",
    );
  });

  test("a name in kana gets its romaji, not its kana again", () => {
    assert.equal(reading("レモン", "レモン", "kana"), null);
    assert.equal(reading("よあそび", "ヨアソビ", "kana"), null);
    assert.equal(reading("よあそび", "ヨアソビ", "romaji"), "yoasobi");
    // With a long vowel mark, which the hiragana reading spells as ー too.
    assert.equal(reading("ルーム", "るーむ", "kana"), null);
    assert.equal(reading("ルーム", "るーむ", "romaji"), "ruumu");
  });
});

describe("pickReadings", () => {
  test("keeps a saved choice and starts as written", () => {
    assert.equal(pickReadings("romaji"), "romaji");
    assert.equal(pickReadings(null), "written");
    assert.equal(pickReadings("furigana"), "written");
  });

  test("an older phone's saved both reads as written", () => {
    assert.equal(pickReadings("both"), "written");
  });
});
