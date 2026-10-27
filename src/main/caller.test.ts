// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { callerFromHeaders, displayToken } from "./caller";

describe("callerFromHeaders", () => {
  test("reads the percent-encoded identity headers", () => {
    assert.deepEqual(
      callerFromHeaders({
        "x-karafriends-device-id": "4f1c-device",
        "x-karafriends-nickname": encodeURIComponent("カラオケ太郎"),
      }),
      { deviceId: "4f1c-device", nickname: "カラオケ太郎", isDisplay: false },
    );
  });

  test("treats missing, empty or garbled headers as absent", () => {
    assert.deepEqual(callerFromHeaders({}), {
      deviceId: null,
      nickname: null,
      isDisplay: false,
    });
    assert.deepEqual(
      callerFromHeaders({
        "x-karafriends-device-id": "  ",
        "x-karafriends-nickname": "%E0%A4%A",
      }),
      { deviceId: null, nickname: null, isDisplay: false },
    );
  });

  test("the display is whoever has the token", () => {
    assert.equal(displayToken.length, 64);
    assert.equal(
      callerFromHeaders({ "x-karafriends-display-token": displayToken })
        .isDisplay,
      true,
    );
    assert.equal(
      callerFromHeaders({ "x-karafriends-display-token": "guess" }).isDisplay,
      false,
    );
    assert.equal(
      callerFromHeaders({
        "x-karafriends-display-token": displayToken.toUpperCase(),
      }).isDisplay,
      false,
    );
  });
});
