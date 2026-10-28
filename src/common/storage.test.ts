// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { getItem, removeItem, setItem } from "./storage";

const g = globalThis as { localStorage?: unknown };

afterEach(() => {
  delete g.localStorage;
});

// A localStorage whose every call throws, as a phone with site data
// blocked has.
function blockedStorage() {
  const blocked = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  g.localStorage = {
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
  };
}

describe("storage", () => {
  test("reads and writes localStorage", () => {
    const items: Record<string, string> = { theme: "dark" };
    g.localStorage = {
      getItem: (key: string) => items[key] ?? null,
      setItem: (key: string, value: string) => (items[key] = value),
      removeItem: (key: string) => delete items[key],
    };
    assert.equal(getItem("theme"), "dark");
    assert.equal(getItem("language"), null);
    setItem("language", "ja");
    assert.equal(items.language, "ja");
    removeItem("theme");
    assert.equal(items.theme, undefined);
  });

  test("never throws when storage is blocked, and keeps values for the page", () => {
    blockedStorage();
    assert.equal(getItem("blocked-nickname"), null);
    setItem("blocked-nickname", "ken");
    assert.equal(getItem("blocked-nickname"), "ken");
    removeItem("blocked-nickname");
    assert.equal(getItem("blocked-nickname"), null);
  });

  test("keeps a value that won't save (storage full) and reads it back", () => {
    g.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Full", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    setItem("full-emotes", "[]");
    assert.equal(getItem("full-emotes"), "[]");
  });

  test("works without any localStorage", () => {
    setItem("none-expanded", "true");
    assert.equal(getItem("none-expanded"), "true");
  });
});
