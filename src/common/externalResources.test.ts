// Runs on Node's test runner through tsx (yarn test:unit). The tools manager
// gets a fake network and fake child processes, and a temp folder for its
// cache: nothing is downloaded and no tool runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  createToolsManager,
  type AssetResponse,
  type ToolsDeps,
} from "./externalResources";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-tools-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const YTDLP = "2026.10.26\n";
const FFMPEG = "ffmpeg version 9.0.2 Copyright (c) 2000-2026\n";

type Answer =
  | { status: 200; body: string; etag?: string }
  | { status: 304 | 404 | 500 }
  | AssetResponse
  | Error;

function response(answer: Exclude<Answer, Error>): AssetResponse {
  if ("headers" in answer) return answer;
  const headers = new Map<string, string>();
  if ("etag" in answer && answer.etag) headers.set("etag", answer.etag);
  return {
    status: answer.status,
    ok: answer.status === 200,
    headers: { get: (name) => headers.get(name) ?? null },
    body: Readable.from(
      answer.status === 200 ? [Buffer.from(answer.body)] : [],
    ),
  };
}

// A manager for Linux x64 whose network answers from `answers`: a function
// of the asset (ytdlp or ffmpeg) and the request's headers. Each fetch is
// recorded.
function setup(
  answers: (
    id: "ytdlp" | "ffmpeg",
    headers: Record<string, string>,
  ) => Answer | Promise<Answer>,
  options: { env?: Record<string, string>; now?: () => number } = {},
) {
  const fetches: { id: "ytdlp" | "ffmpeg"; headers: Record<string, string> }[] =
    [];
  const deps: ToolsDeps = {
    platform: "linux",
    arch: "x64",
    cacheDir: path.join(dir, "cache"),
    extractorPath: "7za",
    env: options.env ?? {},
    fetch: async (url, headers) => {
      const id = url.includes("yt-dlp") ? "ytdlp" : "ffmpeg";
      fetches.push({ id, headers });
      const answer = await answers(id, headers);
      if (answer instanceof Error) throw answer;
      return response(answer);
    },
    // 7za: each pass "unpacks" the archive to the file the next pass (or
    // the plan's binary) expects, with the same contents. A tool prints its
    // file's contents as its version, or fails if they start with "broken".
    exec: async (file, args) => {
      if (file === "7za") {
        const [, archive, , out] = args;
        const name = archive.endsWith(".tar.xz") ? "ffmpeg.tar" : "ffmpeg";
        fs.mkdirSync(out.slice(2), { recursive: true });
        fs.copyFileSync(archive, path.join(out.slice(2), name));
        return "";
      }
      const text = fs.readFileSync(file, "utf8");
      if (text.startsWith("broken")) throw new Error(`${file} won't start`);
      return text;
    },
    now: options.now ?? Date.now,
    tmpDir: dir,
    retry: { retries: 2, minTimeout: 1, factor: 1 },
  };
  const manager = createToolsManager(deps);
  const read = (id: "ytdlp" | "ffmpeg") =>
    fs.readFileSync(manager.resourcePaths[id], "utf8");
  const versions = () =>
    JSON.parse(
      fs.readFileSync(path.join(dir, "cache", "versions.json"), "utf8"),
    );
  return { manager, fetches, read, versions };
}

const fresh = (id: "ytdlp" | "ffmpeg"): Answer => ({
  status: 200,
  body: id === "ytdlp" ? YTDLP : FFMPEG,
  etag: `"${id}-1"`,
});

describe("createToolsManager", () => {
  test("loads nothing and touches nothing until used", () => {
    const { fetches } = setup(fresh);
    assert.equal(fetches.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "cache")), false);
  });

  test("a first launch downloads both tools and records their versions", async () => {
    const { manager, read, versions } = setup(fresh);
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    assert.equal(read("ffmpeg"), FFMPEG);
    const stored = versions();
    assert.equal(stored.ytdlp.etag, '"ytdlp-1"');
    assert.equal(stored.ytdlp.version, "2026.10.26");
    assert.equal(stored.ffmpeg.version, "9.0.2");
    assert.notEqual(manager.status().lastCheck, null);
  });

  test("concurrent and repeat calls share one check", async () => {
    const { manager, fetches } = setup(fresh);
    await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
    await manager.ensure();
    assert.equal(fetches.length, 2);
  });

  test("a 304 keeps the cached copy and asks with its validator", async () => {
    await setup(fresh).manager.ensure();
    const { manager, fetches, read } = setup(() => ({ status: 304 }));
    await manager.ensure();
    const ytdlp = fetches.find((f) => f.id === "ytdlp")!;
    assert.equal(ytdlp.headers["If-None-Match"], '"ytdlp-1"');
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a thrown network error is retried", async () => {
    let calls = 0;
    const { manager, read } = setup((id) =>
      id === "ytdlp" && calls++ === 0 ? new Error("ECONNRESET") : fresh(id),
    );
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    assert.equal(calls, 2);
  });

  test("offline: the cached copies are kept, and the check passes", async () => {
    await setup(fresh).manager.ensure();
    const { manager, fetches, read } = setup(() => new Error("offline"));
    await manager.ensure();
    assert.equal(read("ffmpeg"), FFMPEG);
    // promise-retry: the first try and two retries, for each tool.
    assert.equal(fetches.length, 6);
  });

  test("with nothing cached a failed check rejects, and the next call tries again", async () => {
    let online = false;
    const { manager, read } = setup((id) =>
      online ? fresh(id) : { status: 500 },
    );
    await assert.rejects(manager.ensure());
    online = true;
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a failed refresh keeps the working cached copy", async () => {
    await setup(fresh).manager.ensure();
    // A 200 whose body breaks off.
    const { manager, read } = setup(() => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: Readable.from(
        (async function* () {
          yield Buffer.from("half");
          throw new Error("reset");
        })(),
      ),
    }));
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("Update tools downloads again, without validators", async () => {
    await setup(fresh).manager.ensure();
    const { manager, fetches, read } = setup((id) => ({
      status: 200,
      body: id === "ytdlp" ? "2026.11.01\n" : FFMPEG,
    }));
    await manager.update();
    assert.equal(read("ytdlp"), "2026.11.01\n");
    assert.deepEqual(
      fetches.map((f) => f.headers),
      [{}, {}],
    );
    assert.equal(manager.status().ytdlp.version, "2026.11.01");
  });

  test("a failed Update tools rejects, but downloads go on with the cached tools", async () => {
    await setup(fresh).manager.ensure();
    const { manager, read } = setup(() => ({ status: 500 }));
    const update = manager.update();
    // Queued during the update: waits for it, and isn't failed by it.
    const download = manager.ensure();
    await assert.rejects(update, /500/);
    await download;
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a failed Update tools with no tools cached fails the downloads too", async () => {
    const { manager } = setup(() => ({ status: 500 }));
    const update = manager.update();
    const download = manager.ensure();
    await assert.rejects(update);
    await assert.rejects(download);
  });

  test("Update tools waits for a check in flight, then downloads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { manager, fetches } = setup(async (id) => {
      if (first) {
        first = false;
        await gate;
      }
      return fresh(id);
    });
    const launch = manager.ensure();
    const update = manager.update();
    // Pressing it again joins the same update.
    assert.equal(manager.update(), update);
    release();
    await Promise.all([launch, update]);
    assert.equal(fetches.length, 4);
  });

  test("an overridden tool is never downloaded, and its version is asked", async () => {
    const fake = path.join(dir, "my-yt-dlp");
    fs.writeFileSync(fake, "2026.12.01\n");
    const { manager, fetches } = setup(fresh, {
      env: { KARAFRIENDS_YTDLP_PATH: fake },
    });
    await manager.ensure();
    assert.deepEqual(
      fetches.map((f) => f.id),
      ["ffmpeg"],
    );
    assert.equal(manager.resourcePaths.ytdlp, fake);
    assert.deepEqual(manager.status().ytdlp, {
      version: "2026.12.01",
      updatedAt: null,
      overridden: true,
    });
  });
});
