// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { callerFromHeaders, deviceIdFromQuery, displayToken } from "./caller";

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

describe("deviceIdFromQuery", () => {
  test("takes one non-empty ID", () => {
    assert.equal(deviceIdFromQuery("4f1c-device"), "4f1c-device");
    assert.equal(deviceIdFromQuery(" 4f1c "), "4f1c");
  });

  test("ignores a missing, empty, repeated or oversized one", () => {
    assert.equal(deviceIdFromQuery(undefined), null);
    assert.equal(deviceIdFromQuery(""), null);
    assert.equal(deviceIdFromQuery(["a", "b"]), null);
    assert.equal(deviceIdFromQuery("x".repeat(201)), null);
  });
});
