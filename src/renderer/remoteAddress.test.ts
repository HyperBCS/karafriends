import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addressText, parseCustomUrl } from "./remoteAddress";

describe("parseCustomUrl", () => {
  test("takes an http or https site, with its port, and tidies it", () => {
    for (const [typed, url] of [
      ["https://karaoke.tailnet.ts.net", "https://karaoke.tailnet.ts.net"],
      ["HTTPS://Karaoke.Tailnet.TS.net/", "https://karaoke.tailnet.ts.net"],
      ["  http://203.0.113.5:8080/  ", "http://203.0.113.5:8080"],
      ["https://example.com:443", "https://example.com"],
      ["http://[2001:db8::1]:8080", "http://[2001:db8::1]:8080"],
    ]) {
      assert.deepEqual(parseCustomUrl(typed), { url }, typed);
    }
  });

  test("a host alone, with or without a port, is http", () => {
    assert.deepEqual(parseCustomUrl("100.101.102.103:8080"), {
      url: "http://100.101.102.103:8080",
    });
    assert.deepEqual(parseCustomUrl("brandon-pc.tailnet.ts.net"), {
      url: "http://brandon-pc.tailnet.ts.net",
    });
    // Not read as a "localhost:" scheme.
    assert.deepEqual(parseCustomUrl("localhost:8080"), {
      url: "http://localhost:8080",
    });
  });

  test("says why it won't take one", () => {
    const why = (typed: string) => {
      const parsed = parseCustomUrl(typed);
      assert.ok("error" in parsed, typed);
      return parsed.error;
    };
    assert.match(why(""), /Enter an address/);
    assert.match(why("   "), /Enter an address/);
    assert.match(why("ftp://example.com"), /http:\/\/ or https:\/\//);
    assert.match(why("http://"), /valid address/);
    assert.match(why("http://exa mple.com"), /valid address/);
    assert.match(why("https://me:secret@example.com"), /username and password/);
    assert.match(why("https://example.com/karaoke"), /after the host and port/);
    assert.match(
      why("https://example.com/?party=1"),
      /after the host and port/,
    );
    assert.match(
      why("https://example.com/#/history"),
      /after the host and port/,
    );
  });
});

test("addressText leaves out http:// but not https://", () => {
  assert.equal(addressText("http://192.168.1.20:8080"), "192.168.1.20:8080");
  assert.equal(
    addressText("https://karaoke.tailnet.ts.net"),
    "https://karaoke.tailnet.ts.net",
  );
});
