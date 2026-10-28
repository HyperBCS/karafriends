// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emojisIn } from "./emotes";

describe("emojisIn", () => {
  test("keeps flags, skin tones and joined emoji whole", () => {
    assert.deepEqual(emojisIn("🇯🇵👍🏽👨‍👩‍👧"), ["🇯🇵", "👍🏽", "👨‍👩‍👧"]);
    assert.deepEqual(emojisIn("🏳️‍🌈"), ["🏳️‍🌈"]);
    assert.deepEqual(emojisIn("1️⃣"), ["1️⃣"]);
  });

  test("keeps the defaults as they are", () => {
    assert.deepEqual(emojisIn("🆓🔥❤️"), ["🆓", "🔥", "❤️"]);
  });

  test("drops what isn't an emoji, and repeats", () => {
    assert.deepEqual(emojisIn("yay 🎉 🎉!"), ["🎉"]);
    assert.deepEqual(emojisIn("abc 123"), []);
  });
});
