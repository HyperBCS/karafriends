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
  const extracts: string[][] = [];
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
        extracts.push(args);
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
  return { manager, fetches, extracts, read, versions };
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

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
    // Over a week later, so ffmpeg is asked too.
    const { manager, fetches, read } = setup(() => new Error("offline"), {
      now: () => Date.now() + 2 * WEEK,
    });
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

  test("a download that won't start (wrong CPU, broken) doesn't replace the cached copy", async () => {
    await setup(fresh).manager.ensure();
    const broken = (id: "ytdlp" | "ffmpeg"): Answer => ({
      status: 200,
      body: `broken ${id}`,
      etag: `"${id}-2"`,
    });
    // At launch: kept, and the old validator stays so it's tried again.
    const launch = setup(broken);
    await launch.manager.ensure();
    assert.equal(launch.read("ytdlp"), YTDLP);
    assert.equal(launch.read("ffmpeg"), FFMPEG);
    assert.equal(launch.versions().ytdlp.etag, '"ytdlp-1"');
    // Update tools: kept, and the host is told.
    const update = setup(broken);
    await assert.rejects(update.manager.update(), /won't start/);
    assert.equal(update.read("ytdlp"), YTDLP);
    // Nothing left behind next to the tools.
    assert.deepEqual(
      fs.readdirSync(path.dirname(update.manager.resourcePaths.ytdlp)),
      ["yt-dlp"],
    );
  });

  test("a first download that won't start fails the check", async () => {
    const { manager } = setup((id) => ({ status: 200, body: `broken ${id}` }));
    await assert.rejects(manager.ensure(), /won't start/);
    assert.equal(fs.existsSync(manager.resourcePaths.ffmpeg), false);
  });

  test("a tool from another source is downloaded again, whatever its validator", async () => {
    await setup(fresh).manager.ensure();
    // As if an older version had cached it from another URL.
    const file = path.join(dir, "cache", "versions.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.ffmpeg.url = "https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip";
    fs.writeFileSync(file, JSON.stringify(stored));
    const { manager, fetches, versions } = setup((id) => ({
      status: 200,
      body: id === "ytdlp" ? YTDLP : "ffmpeg version 9.0.3\n",
    }));
    await manager.ensure();
    const ffmpeg = fetches.find((f) => f.id === "ffmpeg")!;
    assert.deepEqual(ffmpeg.headers, {});
    assert.equal(versions().ffmpeg.version, "9.0.3");
    assert.match(versions().ffmpeg.url, /ffmpeg-master-latest/);
  });

  test("ffmpeg is asked about at most once a week, yt-dlp at every launch", async () => {
    let now = Date.now();
    const launch = (answer: (id: "ytdlp" | "ffmpeg") => Answer) => {
      const tools = setup(answer, { now: () => now });
      return tools.manager.ensure().then(() => tools);
    };
    await launch(fresh);

    // The next day, BtbN's daily rebuild has a new etag: not downloaded.
    now += DAY;
    const nextDay = await launch((id) => ({ ...fresh(id), etag: '"new"' }));
    assert.deepEqual(
      nextDay.fetches.map((f) => f.id),
      ["ytdlp"],
    );

    // A week on, it's asked with its validator. A 304 counts as asked.
    now += WEEK;
    const weekOn = await launch(() => ({ status: 304 }));
    assert.deepEqual(
      weekOn.fetches.map((f) => [f.id, f.headers["If-None-Match"]]),
      [
        ["ytdlp", '"new"'],
        ["ffmpeg", '"ffmpeg-1"'],
      ],
    );
    now += DAY;
    const after = await launch(fresh);
    assert.deepEqual(
      after.fetches.map((f) => f.id),
      ["ytdlp"],
    );

    // Update tools asks for both, whenever.
    const update = setup(fresh, { now: () => now });
    await update.manager.update();
    assert.deepEqual(update.fetches.map((f) => f.id).sort(), [
      "ffmpeg",
      "ytdlp",
    ]);
  });

  test("only the ffmpeg binary is unpacked from BtbN's archive", async () => {
    const { manager, extracts, read } = setup(fresh);
    await manager.ensure();
    assert.equal(extracts.length, 2);
    // The .tar.xz to the .tar, whole; then just the files named ffmpeg.
    assert.deepEqual(extracts[0].slice(4), []);
    assert.deepEqual(extracts[1].slice(4), ["ffmpeg", "-r"]);
    assert.equal(read("ffmpeg"), FFMPEG);
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
