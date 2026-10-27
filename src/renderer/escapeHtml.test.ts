// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { test } from "node:test";

import escapeHtml from "./escapeHtml";

test("escapeHtml leaves no markup", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('hi')"> & 歌`),
    "&lt;img src=x onerror=&quot;alert(&#39;hi&#39;)&quot;&gt; &amp; 歌",
  );
});
