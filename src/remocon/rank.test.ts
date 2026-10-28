// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalize } from "../common/readings";
import { type Candidate, rank } from "./rank";

const song = (
  name: string,
  artistName = "",
  nameYomi = "",
  artistNameYomi = "",
): Candidate => ({ name, nameYomi, artistName, artistNameYomi });

// Ranks one catalog's titles and returns them in their new order.
const titles = (query: string, names: string[]) =>
  rank(query, [names.map((name) => song(name))]).map(({ name }) => name);

describe("normalize", () => {
  test("folds width, case, kana and punctuation away", () => {
    assert.equal(normalize("ＬＥＭＯＮ"), "lemon");
    assert.equal(normalize("Lemon (Live ver.)"), "lemonlivever");
    assert.equal(normalize("レモン"), "れもん");
    assert.equal(normalize("ﾚﾓﾝ"), "れもん");
    assert.equal(normalize("夜に駆ける！"), "夜に駆ける");
    assert.equal(normalize("恋 ～ Love"), "恋love");
  });

  test("a long vowel mark is its vowel, after hiragana as after katakana", () => {
    assert.equal(normalize("らーめん"), "らあめん");
    assert.equal(normalize("ラーメン"), "らあめん");
    assert.equal(normalize("ﾗｰﾒﾝ"), "らあめん");
  });
});

describe("rank", () => {
  test("a kanji query: exact, then starts with, then contains, shorter first", () => {
    assert.deepEqual(
      titles("恋", [
        "君に恋した",
        "恋愛サーキュレーション",
        "初恋",
        "恋におちて",
        "恋",
      ]),
      ["恋", "恋におちて", "恋愛サーキュレーション", "初恋", "君に恋した"],
    );
  });

  test("a kana query matches DAM's readings, katakana or hiragana", () => {
    const koi = song("恋", "星野源", "コイ", "ホシノゲン");
    const koibito = song("恋人", "", "コイビト");
    const other = song("夜に駆ける", "YOASOBI", "ヨルニカケル", "ヨアソビ");
    assert.deepEqual(rank("こい", [[other, koibito, koi]]), [
      koi,
      koibito,
      other,
    ]);
    assert.deepEqual(rank("コイ", [[other, koi]]), [koi, other]);
    // An artist's reading, for a song.
    assert.deepEqual(rank("よあそび", [[koi, other]]), [other, koi]);
  });

  test("a hiragana long vowel mark matches a katakana title", () => {
    assert.deepEqual(titles("らーめん", ["恋", "愛ラーメン", "ラーメン"]), [
      "ラーメン",
      "愛ラーメン",
      "恋",
    ]);
  });

  test("a kana query matches Latin titles and artists, as romaji", () => {
    const yoasobi = song("夜に駆ける", "YOASOBI");
    const medley = song("YOASOBIメドレー", "YOASOBI");
    assert.deepEqual(rank("よあそび", [[song("恋"), yoasobi, medley]]), [
      medley,
      yoasobi,
      song("恋"),
    ]);
  });

  test("a romaji query matches Latin titles and DAM's kana readings", () => {
    assert.deepEqual(titles("lemon", ["Lemonade", "LEMON", "Lemon Tree"]), [
      "LEMON",
      "Lemonade",
      "Lemon Tree",
    ]);
    const koi = song("恋", "", "コイ");
    const ai = song("愛", "", "アイ");
    assert.deepEqual(rank("koi", [[ai, koi]]), [koi, ai]);
  });

  test("an artist match counts for less than a title match", () => {
    const byLemon = song("Something", "Lemon");
    const lemon = song("Lemonade", "Someone");
    assert.deepEqual(rank("lemon", [[byLemon, lemon]]), [lemon, byLemon]);
  });

  test("every word of the query, in any order", () => {
    assert.deepEqual(titles("駆ける 夜", ["駆ける", "夜に駆ける", "夜"]), [
      "夜に駆ける",
      "駆ける",
      "夜",
    ]);
  });

  test("ties keep each catalog's order, the catalogs taking turns", () => {
    const dam = [song("Dam 1"), song("Dam 2"), song("Dam 3")];
    const joysound = [song("Joy 1"), song("Joy 2")];
    assert.deepEqual(
      rank("nothing like it", [dam, joysound]).map(({ name }) => name),
      ["Dam 1", "Joy 1", "Dam 2", "Joy 2", "Dam 3"],
    );
  });

  test("a song in both catalogs is there twice, side by side", () => {
    const dam = [song("恋愛サーキュレーション"), song("恋", "星野源")];
    const joysound = [song("恋におちて"), song("恋", "星野源")];
    assert.deepEqual(rank("恋", [dam, joysound]), [
      dam[1],
      joysound[1],
      joysound[0],
      dam[0],
    ]);
  });

  test("an empty query keeps the catalogs' own order", () => {
    const dam = [song("b"), song("a")];
    assert.deepEqual(rank(" ", [dam, []]), dam);
  });
});
