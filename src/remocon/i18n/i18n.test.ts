// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { en } from "./en";
import { countKey, pickLanguage, translate } from "./index";
import { ja } from "./ja";

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("dictionaries", () => {
  test("have the same keys", () => {
    assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
  });

  test("use the same {variables} in each string", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.deepEqual(placeholders(ja[key]), placeholders(en[key]), key);
    }
  });

  test("have no empty strings", () => {
    for (const [key, text] of [...Object.entries(en), ...Object.entries(ja)]) {
      assert.notEqual(text.trim(), "", key);
    }
  });
});

describe("translate", () => {
  test("looks the key up in the language", () => {
    assert.equal(translate("en", "queue.empty"), "The queue is empty");
    assert.equal(translate("ja", "queue.empty"), "予約はありません");
  });

  test("fills in variables", () => {
    assert.equal(
      translate("en", "queue.queuedBy", { nickname: "ken" }),
      "Queued by ken",
    );
    assert.equal(
      translate("ja", "queueButton.downloadingPercent", { percent: 42.6 }),
      "ダウンロード中 42.6%",
    );
  });
});

describe("countKey", () => {
  test("picks English's singular for 1, and its plural for the rest", () => {
    const songs = (count: number) =>
      translate("en", countKey("search.songCount", count, "en"), { count });
    assert.equal(songs(1), "1 song");
    assert.equal(songs(0), "0 songs");
    assert.equal(songs(2), "2 songs");
    assert.equal(
      translate("en", countKey("video.views", 1, "en"), { count: "1" }),
      "1 view",
    );
  });

  test("Japanese has one form", () => {
    assert.equal(countKey("search.songCount", 1, "ja"), "search.songCount");
    assert.equal(
      translate("ja", countKey("search.songCount", 1, "ja"), { count: 1 }),
      "1曲",
    );
  });
});

describe("pickLanguage", () => {
  test("keeps a saved language", () => {
    assert.equal(pickLanguage("ja", "en-US"), "ja");
    assert.equal(pickLanguage("en", "ja-JP"), "en");
  });

  test("falls back to the phone's language", () => {
    assert.equal(pickLanguage(null, "ja-JP"), "ja");
    assert.equal(pickLanguage(null, "ja"), "ja");
    assert.equal(pickLanguage(null, "en-GB"), "en");
    assert.equal(pickLanguage(null, "zh-TW"), "en");
    assert.equal(pickLanguage(null, undefined), "en");
  });

  test("ignores a saved value it doesn't know", () => {
    assert.equal(pickLanguage("fr", "ja-JP"), "ja");
  });
});
