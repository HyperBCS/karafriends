// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { envWithoutHttpProxy } from "./childEnv";

describe("envWithoutHttpProxy", () => {
  const saved = process.env.http_proxy;
  afterEach(() => {
    if (saved === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = saved;
  });

  test("drops http_proxy in any case and keeps the rest", () => {
    const env = {
      http_proxy: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      Http_Proxy: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      PATH: "/usr/bin",
    };
    assert.deepEqual(envWithoutHttpProxy(env), {
      https_proxy: "http://proxy:3128",
      PATH: "/usr/bin",
    });
    // The input is untouched.
    assert.equal(env.http_proxy, "http://proxy:3128");
    assert.equal(env.HTTP_PROXY, "http://proxy:3128");
  });

  test("leaves the main process's environment alone", () => {
    process.env.http_proxy = "http://proxy:3128";
    const env = envWithoutHttpProxy();
    assert.equal(env.http_proxy, undefined);
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.PATH, process.env.PATH);
    // Still there for ffmpeg, and still dropped for the next yt-dlp.
    assert.equal(process.env.http_proxy, "http://proxy:3128");
    assert.equal(envWithoutHttpProxy().http_proxy, undefined);
  });
});
