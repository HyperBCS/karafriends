// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { callerFromHeaders, deviceIdFromQuery } from "./caller";

describe("callerFromHeaders", () => {
  test("reads the percent-encoded identity headers", () => {
    assert.deepEqual(
      callerFromHeaders({
        "x-karafriends-device-id": "4f1c-device",
        "x-karafriends-nickname": encodeURIComponent("カラオケ太郎"),
      }),
      {
        deviceId: "4f1c-device",
        nickname: "カラオケ太郎",
        adminToken: null,
        isDisplay: false,
      },
    );
  });

  test("reads the admin token header", () => {
    const token = "0123abcd".repeat(8);
    assert.deepEqual(
      callerFromHeaders({ "x-karafriends-admin-token": token }),
      { deviceId: null, nickname: null, adminToken: token, isDisplay: false },
    );
    // Repeated (an array) or empty: none.
    for (const value of [[token, token], "", "x".repeat(201)]) {
      assert.equal(
        callerFromHeaders({ "x-karafriends-admin-token": value }).adminToken,
        null,
      );
    }
  });

  test("treats missing, empty or garbled headers as absent", () => {
    assert.deepEqual(callerFromHeaders({}), {
      deviceId: null,
      nickname: null,
      adminToken: null,
      isDisplay: false,
    });
    assert.deepEqual(
      callerFromHeaders({
        "x-karafriends-device-id": "  ",
        "x-karafriends-nickname": "%E0%A4%A",
      }),
      { deviceId: null, nickname: null, adminToken: null, isDisplay: false },
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
