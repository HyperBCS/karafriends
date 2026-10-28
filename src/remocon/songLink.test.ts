// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import songLink, { artistLink } from "./songLink";

describe("songLink", () => {
  test("each kind's page", () => {
    assert.equal(songLink({ kind: "dam", songId: "1234-56" }), "/song/1234-56");
    assert.equal(
      songLink({ kind: "joysound", songId: "789" }),
      "/joysoundSong/789",
    );
    assert.equal(
      songLink({ kind: "youtube", songId: "dQw4w9WgXcQ" }),
      "/search/youtube/dQw4w9WgXcQ",
    );
    assert.equal(
      songLink({ kind: "nico", songId: "sm9" }),
      "/search/niconico/sm9",
    );
  });

  test("a Joysound song keeps its background video", () => {
    assert.equal(
      songLink({
        kind: "joysound",
        songId: "789",
        youtubeVideoId: "dQw4w9WgXcQ",
      }),
      "/joysoundSong/789/dQw4w9WgXcQ",
    );
    assert.equal(
      songLink({ kind: "joysound", songId: "789", youtubeVideoId: null }),
      "/joysoundSong/789",
    );
  });

  test("an ID that isn't a path is kept in one piece", () => {
    assert.equal(songLink({ kind: "dam", songId: "a/b" }), "/song/a%2Fb");
  });
});

describe("artistLink", () => {
  test("each catalog's page", () => {
    assert.equal(artistLink("dam", "42"), "/artist/42");
    assert.equal(artistLink("joysound", "7"), "/joysoundArtist/7");
  });
});
