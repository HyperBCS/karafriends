// Runs on Node's test runner through tsx (yarn test:unit). What a song's
// files are called, and that one song's never match another's.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { joysoundFilesId, songFileNames, songFilesOf } from "./songFiles";

describe("a Joysound song's guide-vocal version", () => {
  const files = (guideVocal: boolean, youtubeVideoId: string | null = null) =>
    songFileNames(
      songFilesOf({
        kind: "joysound",
        songId: "9630",
        youtubeVideoId,
        guideVocal,
      }),
    );

  test("has files of its own, its lyrics included", () => {
    assert.deepEqual(
      [files(false).video, files(false).telop],
      ["joysound-9630-default-opus.mp4", "joysound-9630.joy_02"],
    );
    assert.deepEqual(
      [files(true).video, files(true).telop],
      ["joysound-9630v-default-opus.mp4", "joysound-9630v.joy_02"],
    );
    assert.equal(
      files(true, "bgVideo0001").video,
      "joysound-9630v-bgVideo0001-opus.mp4",
    );
  });

  test("never takes the other version's files for its own", () => {
    const names = (guideVocal: boolean) => {
      const { prefixes, ...named } = files(guideVocal);
      return { prefixes, names: Object.values(named) as string[] };
    };
    for (const [mine, theirs] of [
      [names(true), names(false)],
      [names(false), names(true)],
    ]) {
      for (const name of theirs.names) {
        assert.ok(
          !mine.prefixes.some((prefix) => name.startsWith(prefix)),
          `${name} matches ${mine.prefixes}`,
        );
      }
    }
  });

  test("goes by the song number with a v; the melody version, by the number", () => {
    assert.equal(joysoundFilesId("9630", true), "9630v");
    assert.equal(joysoundFilesId("9630", false), "9630");
    assert.equal(joysoundFilesId("9630", undefined), "9630");
  });
});
