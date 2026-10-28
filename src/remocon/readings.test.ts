// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { pickReadings, reading } from "./readings";

describe("reading", () => {
  test("as written adds nothing", () => {
    assert.equal(reading("恋", "コイ", "written"), null);
  });

  test("gives DAM's kana, or the kana in romaji", () => {
    assert.equal(reading("恋", "こい", "kana"), "こい");
    assert.equal(reading("星野 源", "ほしのげん", "romaji"), "hoshinogen");
  });

  test("both is the kana, then the romaji", () => {
    assert.equal(reading("恋", "こい", "both"), "こい · koi");
  });

  test("the kana are hiragana, whichever DAM gives", () => {
    assert.equal(reading("恋", "コイ", "both"), "こい · koi");
    assert.equal(reading("恋愛", "レンアイ", "kana"), "れんあい");
    assert.equal(
      reading("小さな恋のうた", "ちいさなこいのうた", "kana"),
      "ちいさなこいのうた",
    );
    assert.equal(reading("愛ラーメン", "アイラーメン", "kana"), "あいらーめん");
  });

  test("a song with no reading, such as Joysound's, is just its title", () => {
    for (const mode of ["kana", "romaji", "both"] as const) {
      assert.equal(reading("恋", undefined, mode), null);
      assert.equal(reading("恋", "", mode), null);
    }
  });

  test("a name in Latin letters needs no reading", () => {
    assert.equal(reading("Lemon", "レモン", "both"), null);
    assert.equal(reading("ＬＥＭＯＮ", "レモン", "romaji"), null);
  });

  test("a name in kana gets its romaji, not its kana again", () => {
    assert.equal(reading("レモン", "レモン", "kana"), null);
    assert.equal(reading("よあそび", "ヨアソビ", "both"), "yoasobi");
  });
});

describe("pickReadings", () => {
  test("keeps a saved choice and starts as written", () => {
    assert.equal(pickReadings("romaji"), "romaji");
    assert.equal(pickReadings(null), "written");
    assert.equal(pickReadings("furigana"), "written");
  });
});
