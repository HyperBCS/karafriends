// Runs on Node's test runner through tsx (yarn test:unit). The tools manager
// gets a fake network and fake child processes, and a temp folder for its
// cache: nothing is downloaded and no tool runs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  createToolsManager,
  replaceFile,
  type AssetResponse,
  type FetchOptions,
  type ReplaceOps,
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

const sha256 = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases";
// The pinned ffmpeg build the tests' manager downloads (its checksum is
// FFMPEG's, unless a test pins another).
const FFMPEG_URL = "https://example.com/ffmpeg-9.0.2-linux64-gpl.tar.xz";

// What the fake network is asked for: which release is yt-dlp's latest, a
// release's SHA2-256SUMS or yt-dlp (with the release's tag), or ffmpeg.
type Request =
  | { kind: "latest" }
  | { kind: "sums"; tag: string }
  | { kind: "ytdlp"; tag: string }
  | { kind: "ffmpeg" };

function request(url: string): Request {
  if (url === `${RELEASES}/latest`) return { kind: "latest" };
  const file = url.match(/\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (file && file[2] === "SHA2-256SUMS") return { kind: "sums", tag: file[1] };
  if (file && file[2] === "yt-dlp_linux")
    return { kind: "ytdlp", tag: file[1] };
  assert.equal(url, FFMPEG_URL);
  return { kind: "ffmpeg" };
}

type Answer =
  | { status: 200; body: string }
  | { status: 302; location: string }
  | { status: 404 | 500 }
  | AssetResponse
  | Error;

function response(answer: Exclude<Answer, Error>): AssetResponse {
  if ("headers" in answer) return answer;
  const headers = new Map<string, string>();
  if ("location" in answer) headers.set("location", answer.location);
  if ("body" in answer) {
    headers.set("content-length", String(Buffer.byteLength(answer.body)));
  }
  return {
    status: answer.status,
    ok: answer.status === 200,
    headers: { get: (name) => headers.get(name) ?? null },
    body: Readable.from("body" in answer ? [Buffer.from(answer.body)] : []),
  };
}

// yt-dlp's releases on the fake GitHub, by tag: what the binary prints, and
// the SHA2-256SUMS (the binary's real checksum unless given).
type Releases = Record<string, { ytdlp: string; sums?: string }>;

// A fake upstream: yt-dlp's releases, which one is the latest, and the
// pinned ffmpeg's contents.
function upstream(
  options: { releases?: Releases; latest?: string; ffmpeg?: string } = {},
) {
  const releases = options.releases ?? { "2026.10.26": { ytdlp: YTDLP } };
  const latest = options.latest ?? Object.keys(releases)[0];
  return (req: Request): Answer => {
    switch (req.kind) {
      case "latest":
        return { status: 302, location: `${RELEASES}/tag/${latest}` };
      case "sums": {
        const release = releases[req.tag];
        if (!release) return { status: 404 };
        return {
          status: 200,
          body:
            release.sums ??
            `${sha256("not this one")}  yt-dlp.exe\n` +
              `${sha256(release.ytdlp)}  yt-dlp_linux\n`,
        };
      }
      case "ytdlp": {
        const release = releases[req.tag];
        return release ? { status: 200, body: release.ytdlp } : { status: 404 };
      }
      case "ffmpeg":
        return { status: 200, body: options.ffmpeg ?? FFMPEG };
    }
  };
}

// A manager for Linux x64 whose network answers from `answers`, with
// ffmpeg pinned to FFMPEG_URL and options.ffmpegSha256 (FFMPEG's checksum
// by default). Each fetch is recorded.
function setup(
  answers: (req: Request) => Answer | Promise<Answer> = upstream(),
  options: {
    env?: Record<string, string>;
    now?: () => number;
    onFirstDownload?: ToolsDeps["onFirstDownload"];
    ffmpegSha256?: string;
  } = {},
) {
  const fetches: (Request & { url: string; options: FetchOptions })[] = [];
  const extracts: string[][] = [];
  const deps: ToolsDeps = {
    platform: "linux",
    arch: "x64",
    cacheDir: path.join(dir, "cache"),
    extractorPath: "7za",
    env: options.env ?? {},
    fetch: async (url, fetchOptions) => {
      const req = request(url);
      fetches.push({ ...req, url, options: fetchOptions });
      const answer = await answers(req);
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
    onFirstDownload: options.onFirstDownload,
    sources: {
      ffmpeg: {
        kind: "pinned",
        url: FFMPEG_URL,
        sha256: options.ffmpegSha256 ?? sha256(FFMPEG),
      },
    },
  };
  const manager = createToolsManager(deps);
  const read = (id: "ytdlp" | "ffmpeg") =>
    fs.readFileSync(manager.resourcePaths[id], "utf8");
  const versions = () =>
    JSON.parse(
      fs.readFileSync(path.join(dir, "cache", "versions.json"), "utf8"),
    );
  const kinds = () => fetches.map((f) => f.kind);
  return { manager, fetches, kinds, extracts, read, versions };
}

// What's in the test's folder besides the cache: downloads left behind.
const leftovers = () => fs.readdirSync(dir).filter((name) => name !== "cache");

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

describe("createToolsManager", () => {
  test("loads nothing and touches nothing until used", () => {
    const { fetches } = setup();
    assert.equal(fetches.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "cache")), false);
  });

  test("a first download says how far along it is, then that it's done; a refresh doesn't", async () => {
    const reports: ({ percent: number | null } | null)[] = [];
    const { manager } = setup(upstream(), {
      onFirstDownload: (progress) => reports.push(progress),
    });
    await manager.ensure();
    assert.equal(reports.at(-1), null);
    const percents = reports.flatMap((report) =>
      report === null ? [] : [report.percent],
    );
    assert.ok(percents.length > 0);
    assert.ok(percents.includes(100), JSON.stringify(percents));
    // Never backwards, and never past 100.
    for (let i = 1; i < percents.length; i++) {
      assert.ok((percents[i] ?? 0) >= (percents[i - 1] ?? 0), String(percents));
      assert.ok((percents[i] ?? 0) <= 100);
    }
    // The tools are there now: a new yt-dlp release says nothing.
    reports.length = 0;
    const later = setup(
      upstream({ releases: { "2026.11.01": { ytdlp: "2026.11.01\n" } } }),
      { onFirstDownload: (progress) => reports.push(progress) },
    );
    await later.manager.ensure();
    assert.equal(later.read("ytdlp"), "2026.11.01\n");
    assert.deepEqual(reports, []);
  });

  test("a first launch downloads both tools, checks them, and records them", async () => {
    const { manager, read, versions, fetches } = setup();
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    assert.equal(read("ffmpeg"), FFMPEG);
    assert.deepEqual(versions(), {
      ytdlp: {
        version: "2026.10.26",
        updatedAt: versions().ytdlp.updatedAt,
        url: `${RELEASES}/download/2026.10.26/yt-dlp_linux`,
        sha256: sha256(YTDLP),
      },
      ffmpeg: {
        version: "9.0.2",
        updatedAt: versions().ffmpeg.updatedAt,
        url: FFMPEG_URL,
        sha256: sha256(FFMPEG),
      },
    });
    // "latest" is asked without following its redirect.
    assert.deepEqual(fetches.find((f) => f.kind === "latest")!.options, {
      redirect: "manual",
    });
    assert.notEqual(manager.status().lastCheck, null);
    // Written through a temp file, renamed into place.
    assert.deepEqual(fs.readdirSync(path.join(dir, "cache")).sort(), [
      "ffmpeg",
      "versions.json",
      "ytdlp",
    ]);
    assert.deepEqual(leftovers(), []);
  });

  test("concurrent and repeat calls share one check", async () => {
    const { manager, fetches } = setup();
    await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
    await manager.ensure();
    // yt-dlp's latest release, its sums and itself; and ffmpeg.
    assert.equal(fetches.length, 4);
  });

  test("the same yt-dlp release isn't downloaded again, and the pinned ffmpeg isn't asked about", async () => {
    await setup().manager.ensure();
    const { manager, kinds, read } = setup();
    await manager.ensure();
    assert.deepEqual(kinds(), ["latest"]);
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a new yt-dlp release is downloaded, and checked against its own sums", async () => {
    await setup().manager.ensure();
    const { manager, fetches, read, versions } = setup(
      upstream({
        releases: {
          "2026.10.26": { ytdlp: YTDLP },
          "2026.11.01": { ytdlp: "2026.11.01\n" },
        },
        latest: "2026.11.01",
      }),
    );
    await manager.ensure();
    assert.equal(read("ytdlp"), "2026.11.01\n");
    assert.deepEqual(
      fetches.map((f) => ("tag" in f ? [f.kind, f.tag] : [f.kind])),
      [["latest"], ["sums", "2026.11.01"], ["ytdlp", "2026.11.01"]],
    );
    assert.equal(versions().ytdlp.sha256, sha256("2026.11.01\n"));
  });

  test("yt-dlp and its checksum come from one release, even if another is published meanwhile", async () => {
    // 2026.11.01 is published just after "latest" said 2026.10.26.
    let latest = "2026.10.26";
    const releases: Releases = {
      "2026.10.26": { ytdlp: YTDLP },
      "2026.11.01": { ytdlp: "2026.11.01\n" },
    };
    const { manager, fetches, read, versions } = setup((req) => {
      const answer = upstream({ releases, latest })(req);
      if (req.kind === "latest") latest = "2026.11.01";
      return answer;
    });
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    for (const f of fetches) {
      if ("tag" in f) assert.equal(f.tag, "2026.10.26", f.url);
    }
    assert.equal(
      versions().ytdlp.url,
      `${RELEASES}/download/2026.10.26/yt-dlp_linux`,
    );
  });

  test("a download that doesn't match its checksum is deleted, and the cached copy stays", async () => {
    await setup().manager.ensure();
    const before = setup().versions();
    // A release whose yt-dlp isn't the one its sums describe.
    const tampered = upstream({
      releases: {
        "2026.11.01": {
          ytdlp: "2026.11.01 but not quite\n",
          sums: `${sha256("2026.11.01\n")}  yt-dlp_linux\n`,
        },
      },
    });
    // At launch: kept, and the check passes.
    const launch = setup(tampered);
    await launch.manager.ensure();
    assert.equal(launch.read("ytdlp"), YTDLP);
    assert.deepEqual(launch.versions(), before);
    assert.deepEqual(leftovers(), []);
    // Update tools: kept, and the host is told. ffmpeg, served right, is
    // installed again.
    const update = setup(tampered);
    await assert.rejects(
      update.manager.update(),
      /the downloaded yt-dlp doesn't match its checksum, so it wasn't installed/,
    );
    assert.equal(update.read("ytdlp"), YTDLP);
    assert.equal(update.read("ffmpeg"), FFMPEG);
    assert.deepEqual(leftovers(), []);
    assert.deepEqual(
      fs.readdirSync(path.dirname(update.manager.resourcePaths.ytdlp)),
      ["yt-dlp"],
    );
  });

  test("an ffmpeg archive that doesn't match isn't unpacked, and the old ffmpeg stays", async () => {
    await setup().manager.ensure();
    // As if an older karafriends had downloaded another build.
    const file = path.join(dir, "cache", "versions.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.ffmpeg.url =
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z";
    fs.writeFileSync(file, JSON.stringify(stored));
    const { manager, kinds, extracts, read, versions } = setup(
      upstream({ ffmpeg: "ffmpeg version 9.0.3 from somewhere else\n" }),
    );
    await manager.ensure();
    assert.ok(kinds().includes("ffmpeg"));
    assert.deepEqual(extracts, []);
    assert.equal(read("ffmpeg"), FFMPEG);
    assert.equal(versions().ffmpeg.url, stored.ffmpeg.url);
    assert.deepEqual(leftovers(), []);
  });

  test("a first download that doesn't match fails the check and installs nothing", async () => {
    const { manager } = setup(upstream({ ffmpeg: "something else" }));
    await assert.rejects(manager.ensure(), /ffmpeg doesn't match its checksum/);
    assert.equal(fs.existsSync(manager.resourcePaths.ffmpeg), false);
    assert.deepEqual(leftovers(), []);
  });

  test("a release whose sums don't list yt-dlp isn't downloaded", async () => {
    const { manager, kinds } = setup(
      upstream({
        releases: {
          "2026.10.26": {
            ytdlp: YTDLP,
            sums: `${sha256(YTDLP)}  yt-dlp.exe\n`,
          },
        },
      }),
    );
    await assert.rejects(manager.ensure(), /has no checksum for yt-dlp_linux/);
    assert.ok(!kinds().includes("ytdlp"));
    assert.equal(fs.existsSync(manager.resourcePaths.ytdlp), false);
  });

  test("a 'latest' that doesn't name a release fails like the network", async () => {
    await setup().manager.ensure();
    const answers = (req: Request): Answer =>
      req.kind === "latest"
        ? { status: 302, location: "https://github.com/login" }
        : upstream()(req);
    // At launch the cached copy stays; Update tools says why.
    await setup(answers).manager.ensure();
    await assert.rejects(
      setup(answers).manager.update(),
      /didn't say which release is the latest/,
    );
  });

  test("a thrown network error is retried", async () => {
    let calls = 0;
    const { manager, read } = setup((req) =>
      req.kind === "ytdlp" && calls++ === 0
        ? new Error("ECONNRESET")
        : upstream()(req),
    );
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    assert.equal(calls, 2);
  });

  test("offline: the cached copies are kept, and the check passes", async () => {
    await setup().manager.ensure();
    const { manager, kinds, read } = setup(() => new Error("offline"));
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
    assert.equal(read("ffmpeg"), FFMPEG);
    // promise-retry: the first try and two retries, for yt-dlp's latest
    // release. The pinned ffmpeg isn't asked about.
    assert.deepEqual(kinds(), ["latest", "latest", "latest"]);
  });

  test("with nothing cached a failed check rejects, and the next call tries again", async () => {
    let online = false;
    const { manager, read } = setup((req) =>
      online ? upstream()(req) : { status: 500 },
    );
    await assert.rejects(manager.ensure());
    online = true;
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a failed refresh keeps the working cached copy", async () => {
    await setup().manager.ensure();
    // A new release whose download breaks off.
    const { manager, read } = setup((req) =>
      req.kind === "ytdlp"
        ? {
            status: 200,
            ok: true,
            headers: { get: () => null },
            body: Readable.from(
              (async function* () {
                yield Buffer.from("half");
                throw new Error("reset");
              })(),
            ),
          }
        : upstream({ releases: { "2026.11.01": { ytdlp: "2026.11.01\n" } } })(
            req,
          ),
    );
    await manager.ensure();
    assert.equal(read("ytdlp"), YTDLP);
  });

  test("a download that won't start (wrong CPU, broken) doesn't replace the cached copy", async () => {
    await setup().manager.ensure();
    // Checksums that match: the builds themselves are broken.
    const broken = upstream({
      releases: { "2026.11.01": { ytdlp: "broken ytdlp" } },
      ffmpeg: "broken ffmpeg",
    });
    const options = { ffmpegSha256: sha256("broken ffmpeg") };
    // At launch: kept, and the old release stays recorded, so it's tried
    // again.
    const launch = setup(broken, options);
    await launch.manager.ensure();
    assert.equal(launch.read("ytdlp"), YTDLP);
    assert.match(launch.versions().ytdlp.url, /\/2026\.10\.26\//);
    // Update tools: kept, and the host is told.
    const update = setup(broken, options);
    await assert.rejects(update.manager.update(), /won't start/);
    assert.equal(update.read("ytdlp"), YTDLP);
    assert.equal(update.read("ffmpeg"), FFMPEG);
    // Nothing left behind next to the tools.
    assert.deepEqual(
      fs.readdirSync(path.dirname(update.manager.resourcePaths.ytdlp)),
      ["yt-dlp"],
    );
  });

  test("a first download that won't start fails the check", async () => {
    const { manager } = setup(
      upstream({
        releases: { "2026.10.26": { ytdlp: "broken ytdlp" } },
        ffmpeg: "broken ffmpeg",
      }),
      { ffmpegSha256: sha256("broken ffmpeg") },
    );
    await assert.rejects(manager.ensure(), /won't start/);
    assert.equal(fs.existsSync(manager.resourcePaths.ffmpeg), false);
  });

  test("a tool from another source is replaced by the pinned build", async () => {
    await setup().manager.ensure();
    // As if an older karafriends had cached it from another URL.
    const file = path.join(dir, "cache", "versions.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.ffmpeg = {
      etag: '"old"',
      url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
      version: "N-127000-gabcdef0-20260930",
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    const { manager, fetches, versions } = setup();
    await manager.ensure();
    assert.deepEqual(fetches.find((f) => f.kind === "ffmpeg")!.options, {});
    assert.equal(versions().ffmpeg.version, "9.0.2");
    assert.equal(versions().ffmpeg.url, FFMPEG_URL);
    assert.equal(versions().ffmpeg.etag, undefined);
  });

  test("a copy whose source wasn't recorded stays a week without asking, then is replaced", async () => {
    // As a test's stand-ins, or an old karafriends' tools: no versions.json.
    const first = setup();
    for (const file of Object.values(first.manager.resourcePaths)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    }
    await first.manager.ensure();
    assert.deepEqual(first.fetches, []);
    const later = setup(upstream(), { now: () => Date.now() + 2 * WEEK });
    await later.manager.ensure();
    assert.equal(later.read("ytdlp"), YTDLP);
    assert.equal(later.read("ffmpeg"), FFMPEG);
  });

  test("only the ffmpeg binary is unpacked from its .tar.xz", async () => {
    const { manager, extracts, read } = setup();
    await manager.ensure();
    assert.equal(extracts.length, 2);
    // The .tar.xz to the .tar, whole; then just the files named ffmpeg.
    assert.deepEqual(extracts[0].slice(4), []);
    assert.deepEqual(extracts[1].slice(4), ["ffmpeg", "-r"]);
    assert.equal(read("ffmpeg"), FFMPEG);
  });

  test("Update tools installs the pinned ffmpeg again, and the latest checked yt-dlp", async () => {
    await setup().manager.ensure();
    const { manager, kinds, read } = setup(
      upstream({ releases: { "2026.11.01": { ytdlp: "2026.11.01\n" } } }),
    );
    await manager.update();
    assert.equal(read("ytdlp"), "2026.11.01\n");
    assert.equal(read("ffmpeg"), FFMPEG);
    assert.deepEqual(kinds().sort(), ["ffmpeg", "latest", "sums", "ytdlp"]);
    assert.equal(manager.status().ytdlp.version, "2026.11.01");
  });

  test("Update tools downloads yt-dlp again even when its release is the same", async () => {
    await setup().manager.ensure();
    const { manager, kinds } = setup();
    await manager.update();
    assert.deepEqual(kinds().sort(), ["ffmpeg", "latest", "sums", "ytdlp"]);
  });

  test("a failed Update tools rejects, but downloads go on with the cached tools", async () => {
    await setup().manager.ensure();
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
    const { manager, fetches } = setup(async (req) => {
      if (first) {
        first = false;
        await gate;
      }
      return upstream()(req);
    });
    const launch = manager.ensure();
    const update = manager.update();
    // Pressing it again joins the same update.
    assert.equal(manager.update(), update);
    release();
    await Promise.all([launch, update]);
    // Each check: yt-dlp's latest release, its sums and itself; and ffmpeg.
    assert.equal(fetches.length, 8);
  });

  test("an overridden tool is never downloaded, and its version is asked", async () => {
    const fake = path.join(dir, "my-yt-dlp");
    fs.writeFileSync(fake, "2026.12.01\n");
    const { manager, kinds } = setup(upstream(), {
      env: { KARAFRIENDS_YTDLP_PATH: fake },
    });
    await manager.ensure();
    assert.deepEqual(kinds(), ["ffmpeg"]);
    assert.equal(manager.resourcePaths.ytdlp, fake);
    assert.deepEqual(manager.status().ytdlp, {
      version: "2026.12.01",
      updatedAt: null,
      overridden: true,
    });
  });
});

// Windows' rules for a running .exe, in memory: it can be renamed, but not
// replaced or deleted, until it exits. `locked` files can't even be renamed.
function fakeWindows(files: Record<string, string>) {
  const running = new Set<string>();
  const locked = new Set<string>();
  const sleeps: number[] = [];
  const fail = (code: string) =>
    Object.assign(new Error(`${code}: operation not permitted`), { code });
  const ops: ReplaceOps = {
    copyFile: async (src, dest) => {
      files[dest] = files[src];
    },
    rename: async (from, to) => {
      if (locked.has(from) || running.has(to)) throw fail("EPERM");
      if (!(from in files)) throw fail("ENOENT");
      files[to] = files[from];
      delete files[from];
      if (running.delete(from)) running.add(to);
    },
    remove: async (file) => {
      if (running.has(file)) throw fail("EPERM");
      delete files[file];
    },
    exists: (file) => file in files,
    sleep: async (ms) => {
      sleeps.push(ms);
      // The tool finishes while we wait.
      locked.clear();
    },
  };
  return { files, running, locked, sleeps, ops };
}

describe("replaceFile", () => {
  const dest = "C:\\tools\\ffmpeg.exe";
  let time = 1;
  const now = () => time++;

  test("Windows: a running tool is set aside and replaced at once", async () => {
    const win = fakeWindows({ new: "9.0.2", [dest]: "7.1" });
    win.running.add(dest);
    await replaceFile("new", dest, "win32", win.ops, [10], now);
    assert.equal(win.files[dest], "9.0.2");
    assert.deepEqual(win.sleeps, []);
    // The old copy is still running, so it stays for a later check.
    const left = Object.keys(win.files).filter((f) => f !== "new");
    assert.equal(left.length, 2);
    assert.match(
      left.find((f) => f !== dest)!,
      /ffmpeg\.exe\.\d+\.old$/,
    );
  });

  test("Windows: an idle old copy is removed", async () => {
    const win = fakeWindows({ new: "9.0.2", [dest]: "7.1" });
    await replaceFile("new", dest, "win32", win.ops, [10], now);
    assert.deepEqual(Object.keys(win.files).sort(), [dest, "new"].sort());
  });

  test("Windows: a locked tool is tried again after a wait", async () => {
    const win = fakeWindows({ new: "9.0.2", [dest]: "7.1" });
    win.locked.add(dest);
    await replaceFile("new", dest, "win32", win.ops, [10, 20], now);
    assert.equal(win.files[dest], "9.0.2");
    assert.deepEqual(win.sleeps, [10]);
  });

  test("still locked after every wait: the old copy stays, and no .part", async () => {
    const win = fakeWindows({ new: "9.0.2", [dest]: "7.1" });
    win.locked.add(dest);
    win.ops.sleep = async (ms) => {
      win.sleeps.push(ms);
    };
    await assert.rejects(
      replaceFile("new", dest, "win32", win.ops, [10, 20], now),
      /EPERM/,
    );
    assert.deepEqual(win.sleeps, [10, 20]);
    assert.equal(win.files[dest], "7.1");
    assert.equal(`${dest}.part` in win.files, false);
  });

  test("elsewhere: renamed over the old copy", async () => {
    const files: Record<string, string> = { new: "9.0.2", "/t/ffmpeg": "7.1" };
    const { ops } = fakeWindows(files);
    await replaceFile("new", "/t/ffmpeg", "linux", ops, [], now);
    assert.deepEqual(files, { new: "9.0.2", "/t/ffmpeg": "9.0.2" });
  });

  test("a check removes the copies set aside and .part files", async () => {
    await setup().manager.ensure();
    const { manager } = setup();
    const tools = path.dirname(manager.resourcePaths.ffmpeg);
    fs.writeFileSync(path.join(tools, "ffmpeg.1700000000000.old"), "old");
    fs.writeFileSync(path.join(tools, "ffmpeg.part"), "part");
    await manager.update();
    assert.deepEqual(fs.readdirSync(tools), ["ffmpeg"]);
  });
});
