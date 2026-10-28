import { execFile } from "child_process";
import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";

import promiseRetry from "promise-retry";

import { httpFetch } from "../main/http";
import type { ToolsStatus } from "./api";
import { toolCommand } from "./downloadFailure";
import {
  AssetPlan,
  assetPlans,
  canSkipUnvalidated,
  conditionalHeaders,
  extractorFileName,
  fromOtherSource,
  isStale,
  parseToolVersion,
  ResourcePaths,
  resourcePathsFor,
  TOOL_PATH_ENV,
  toolOverrides,
  toolStatus,
  Versions,
} from "./externalResourcesPlan";

// External runtime binaries are downloaded lazily on the user's machine and
// cached here so they are fetched once and reused across launches, instead of
// being bundled into every build. They still need to stay current: the upstream
// tools update frequently (some are pinned to a "latest" release), so on each
// launch we ask the server whether a newer version exists and refresh only when
// it does. The archive extractor is the only piece that ships with the app (see
// extraResources), because we need it to unpack these downloads at runtime.
//
// The pure planning and decision logic lives in externalResourcesPlan.ts.
// This module does the downloads, through createToolsManager, which takes
// its paths, network and child processes as arguments so unit tests can
// fake them. Nothing runs at load: the app's one manager is made on first
// use, from Electron's paths (see the end of this file).
//
// No Electron imports at the top, so unit tests can load this file under
// plain Node.

// What fetchAsset needs from a response: node-fetch's, through httpFetch,
// or a test's fake.
export interface AssetResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: NodeJS.ReadableStream | null;
}

export interface ToolsDeps {
  platform: NodeJS.Platform;
  // process.arch: which build of each tool to download.
  arch: string;
  // Where the tools and versions.json are kept.
  cacheDir: string;
  // 7za, which unpacks the archives.
  extractorPath: string;
  // KARAFRIENDS_YTDLP_PATH and KARAFRIENDS_FFMPEG_PATH, if set: those tools
  // are used as they are, and never downloaded.
  env: Record<string, string | undefined>;
  // One GET with these headers. Rejects on a network error or a timeout.
  fetch(url: string, headers: Record<string, string>): Promise<AssetResponse>;
  // Runs file with args; resolves with its stdout, or rejects if it can't
  // start, fails or runs longer than timeoutMs.
  exec(
    file: string,
    args: string[],
    options: { timeoutMs: number; windowsVerbatimArguments?: boolean },
  ): Promise<string>;
  now(): number;
  // Where downloads are unpacked before they move into the cache.
  tmpDir: string;
  // fetchAsset's retries (promise-retry's options).
  retry?: { retries: number; minTimeout: number; factor?: number };
}

export interface ToolsManager {
  readonly resourcePaths: ResourcePaths;
  // Makes sure the tools are present and up to date, fetching or refreshing
  // them as needed. Runs its checks once: concurrent and repeat calls share
  // a single in-flight promise, and a failed attempt is cleared so a later
  // call can retry.
  ensure(): Promise<void>;
  // Settings' Update tools: downloads each tool that isn't overridden
  // again, whatever the cache says, and records the versions. Rejects if a
  // download failed; the copy in the cache stays.
  update(): Promise<void>;
  // The tools' versions, and when they were last checked. (The problem is
  // the live state's: services.ts adds it.)
  status(): Omit<ToolsStatus, "problem" | "problemSince">;
}

// Without an answer for this long, before the headers or between two chunks
// of the body, a download is given up and retried. ensure() is
// single-flight, so one hung fetch would otherwise wedge every download.
const SILENCE_MS = 60_000;

// How long a tool may take to say its version, and 7za to unpack a download.
const VERSION_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_RETRY = { retries: 5, minTimeout: 1000, factor: 2 };

export function createToolsManager(deps: ToolsDeps): ToolsManager {
  const { cacheDir } = deps;
  const versionsFile = path.join(cacheDir, "versions.json");
  const overrides = toolOverrides(deps.env);
  const resourcePaths: ResourcePaths = {
    ...resourcePathsFor(deps.platform, cacheDir),
    ...overrides,
  };

  for (const [id, file] of Object.entries(overrides)) {
    console.info(
      `Using ${file} for ${id} (${TOOL_PATH_ENV[id as keyof ResourcePaths]})`,
    );
  }

  const readVersions = (): Versions => {
    try {
      return JSON.parse(fs.readFileSync(versionsFile, "utf8"));
    } catch {
      return {};
    }
  };

  const writeVersions = async (versions: Versions): Promise<void> => {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(versionsFile, JSON.stringify(versions, null, 2));
  };

  // A GET that answers 200 (changed, or a first download) or 304
  // (unchanged), retried with backoff. Some hosts (e.g. CDNs that
  // rate-limit certain IPs) reset the connection instead of answering with
  // an error, so a thrown error is retried too: promise-retry by itself
  // only retries what is passed to retry().
  const fetchAsset = (
    url: string,
    headers: Record<string, string>,
  ): Promise<AssetResponse> =>
    promiseRetry(async (retry) => {
      let res: AssetResponse;
      try {
        res = await deps.fetch(url, headers);
      } catch (err) {
        return retry(err);
      }
      if (res.ok || res.status === 304) return res;
      (res.body as Readable | null)?.destroy?.();
      return retry(new Error(`${res.status} from ${url}`));
    }, deps.retry ?? DEFAULT_RETRY);

  const extract = async (archive: string, outDir: string): Promise<void> => {
    await deps.exec(deps.extractorPath, ["e", archive, "-y", `-o${outDir}`], {
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
  };

  // Download an asset into `tmpDir`, unpack it per its plan, and return the
  // path of the finished binary to move into place.
  const materialize = async (
    plan: AssetPlan,
    tmpDir: string,
    res: AssetResponse,
  ): Promise<string> => {
    if (res.body === null) throw new Error(`${plan.url} sent no body`);
    if (plan.download.kind === "binary") {
      // Named as in the cache: Windows only runs a .exe.
      const bin = path.join(tmpDir, path.basename(plan.dest));
      await pipeline(res.body, fs.createWriteStream(bin));
      return bin;
    }

    const { archiveName, steps, binary } = plan.download;
    await pipeline(
      res.body,
      fs.createWriteStream(path.join(tmpDir, archiveName)),
    );
    for (const step of steps) {
      await extract(
        path.join(tmpDir, step.input),
        path.join(tmpDir, step.outDir),
      );
    }
    return path.join(tmpDir, binary);
  };

  // Make sure a single asset is present and up to date. Returns true when
  // the cached copy changed (so the version metadata needs to be persisted).
  // force: download it whatever the cache says, and fail if that fails (the
  // cached copy stays).
  const ensureAsset = async (
    plan: AssetPlan,
    versions: Versions,
    force: boolean,
  ): Promise<boolean> => {
    const exists = fs.existsSync(plan.dest);
    const otherSource = fromOtherSource(versions[plan.id], plan.url);
    const stored = otherSource ? undefined : versions[plan.id];
    const stale =
      exists && !otherSource ? isStale(mtimeMs(plan.dest), deps.now()) : true;

    // Without a stored validator we cannot make a conditional request, so a
    // plain GET would re-download every launch. Skip until the cached copy
    // is stale.
    if (!force && canSkipUnvalidated(exists, stored, stale)) {
      return false;
    }

    let res: AssetResponse;
    try {
      res = await fetchAsset(
        plan.url,
        force ? {} : conditionalHeaders(exists, stored),
      );
    } catch (err) {
      // Offline or the server is unreachable. Keep whatever we already
      // have; only fail if there is nothing cached to fall back on.
      if (exists && !force) {
        console.error(
          `Keeping cached ${plan.id}; version check failed: ${err}`,
        );
        return false;
      }
      throw err;
    }

    if (res.status === 304) {
      if (versions[plan.id]?.url === plan.url) return false;
      // Recorded before URLs were.
      versions[plan.id] = { ...versions[plan.id], url: plan.url };
      return true;
    }

    const tmpDir = fs.mkdtempSync(
      path.join(deps.tmpDir, "karafriends_externalResources"),
    );
    let version: string | null;
    try {
      const src = await materialize(plan, tmpDir, res);
      if (deps.platform !== "win32") {
        fs.chmodSync(src, 0o755);
      }
      // Run it where it is before it replaces anything: a build for another
      // CPU (an Intel ffmpeg on an Apple Silicon Mac without Rosetta, say)
      // or a broken download won't start, and the cached copy stays.
      version = await toolVersion(plan.id, src);
      if (version === null) {
        throw new Error(`the downloaded ${plan.id} won't start`);
      }
      await finalize(src, plan.dest);
    } catch (err) {
      // A failed refresh must not destroy a working cached copy.
      if (exists && !force) {
        console.error(`Keeping cached ${plan.id}; update failed: ${err}`);
        return false;
      }
      throw err;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    versions[plan.id] = {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      version,
      updatedAt: deps.now(),
      url: plan.url,
    };
    return true;
  };

  // What tool id at bin says its version is, or null if it can't say.
  // ffmpeg takes -version; it refuses --version.
  const toolVersion = async (
    id: AssetPlan["id"],
    bin: string,
  ): Promise<string | null> => {
    const command = toolCommand(
      bin,
      [id === "ffmpeg" ? "-version" : "--version"],
      deps.platform,
    );
    try {
      const stdout = await deps.exec(command.file, command.args, {
        timeoutMs: VERSION_TIMEOUT_MS,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
      return parseToolVersion(stdout);
    } catch (err) {
      console.error(`Couldn't get the version of ${bin}: ${err}`);
      return null;
    }
  };

  // The overridden tools' versions, asked at each check.
  const overrideVersions: Partial<Record<AssetPlan["id"], string | null>> = {};
  let lastCheck: number | null = null;

  const toolsPresent = () =>
    fs.existsSync(resourcePaths.ffmpeg) && fs.existsSync(resourcePaths.ytdlp);

  const doEnsure = async (force: boolean): Promise<void> => {
    const plans = assetPlans(deps.platform, deps.arch, resourcePaths).filter(
      (plan) => !(plan.id in overrides),
    );
    const versions = readVersions();

    const results = await Promise.allSettled(
      plans.map((plan) => ensureAsset(plan, versions, force)),
    );
    let changed = results.some(
      (result) => result.status === "fulfilled" && result.value,
    );

    // Record the version of each tool just downloaded, or cached before
    // versions were recorded (their file's time stands in for the
    // download's). A tool that can't say is asked again next launch.
    await Promise.all([
      ...plans.map(async (plan) => {
        if (versions[plan.id]?.version || !fs.existsSync(plan.dest)) return;
        const version = await toolVersion(plan.id, plan.dest);
        if (version === null) return;
        versions[plan.id] = {
          ...versions[plan.id],
          version,
          updatedAt:
            versions[plan.id]?.updatedAt ?? Math.round(mtimeMs(plan.dest)),
        };
        changed = true;
      }),
      ...(Object.entries(overrides) as [AssetPlan["id"], string][]).map(
        async ([id, file]) => {
          overrideVersions[id] = await toolVersion(id, file);
        },
      ),
    ]);

    if (changed) {
      await writeVersions(versions);
    }

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    for (const [id, file] of Object.entries(overrides)) {
      if (!fs.existsSync(file)) {
        throw new Error(
          `${TOOL_PATH_ENV[id as keyof ResourcePaths]} names ${file}, which doesn't exist`,
        );
      }
    }
    if (!toolsPresent()) {
      throw new Error("An external resource wasn't successfully downloaded!");
    }
    lastCheck = deps.now();
  };

  let ensurePromise: Promise<void> | null = null;
  let updatePromise: Promise<void> | null = null;

  // Runs a check once any check in flight is done, and makes it the one
  // downloads wait for. A failed check is cleared so a later call can retry,
  // except a forced one that leaves both tools in place: downloads go on
  // with the old copies, and only updateTools' caller sees the failure.
  const check = (force: boolean): Promise<void> => {
    const previous = ensurePromise?.catch(() => {}) ?? Promise.resolve();
    const run = previous.then(() => doEnsure(force));
    const promise: Promise<void> = run.catch((err) => {
      if (force && toolsPresent()) return;
      if (ensurePromise === promise) ensurePromise = null;
      throw err;
    });
    ensurePromise = promise;
    if (!force) return promise;
    // The forced failure reaches updateTools' caller through run.
    promise.catch(() => {});
    return run;
  };

  return {
    resourcePaths,
    ensure: () => ensurePromise ?? check(false),
    update() {
      updatePromise ??= check(true).finally(() => {
        updatePromise = null;
      });
      return updatePromise;
    },
    status() {
      const stored = readVersions();
      return {
        ffmpeg: toolStatus("ffmpeg", stored, overrides, overrideVersions),
        ytdlp: toolStatus("ytdlp", stored, overrides, overrideVersions),
        lastCheck,
      };
    },
  };
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Move a finished binary into its final cached location atomically: write to
// a sibling temp file (same directory, so the rename stays on one
// filesystem) and rename into place last. An interrupted refresh therefore
// never leaves a file that looks complete, and never corrupts the copy
// already in use.
async function finalize(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await fsp.copyFile(src, partial);
  await fsp.rename(partial, dest);
}

const execFileAsync = promisify(execFile);

// The app's manager, made on first use. Electron is loaded here rather than
// at the top, so unit tests can load this file under plain Node.
let appManager: ToolsManager | null = null;

function tools(): ToolsManager {
  if (appManager) return appManager;
  const { app } = require("electron") as typeof import("electron");
  // The extractor is in the packaged app's resources. Unpackaged, it's in
  // extraResources/ at the top of the repo, where the build copies it; this
  // file is bundled into build/<prod|dev>/main.
  const extractorDir = app.isPackaged
    ? path.join(process.resourcesPath, "extraResources")
    : path.join(__dirname, "..", "..", "..", "extraResources");
  appManager = createToolsManager({
    platform: process.platform,
    arch: process.arch,
    cacheDir: path.join(app.getPath("userData"), "externalResources"),
    extractorPath: path.join(extractorDir, extractorFileName(process.platform)),
    env: process.env,
    fetch: (url, headers) => httpFetch(url, { headers, timeoutMs: SILENCE_MS }),
    exec: async (file, args, options) =>
      (
        await execFileAsync(file, args, {
          timeout: options.timeoutMs,
          windowsHide: true,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout,
    now: Date.now,
    tmpDir: os.tmpdir(),
  });
  return appManager;
}

export function getResourcePaths(): ResourcePaths {
  return tools().resourcePaths;
}

// Make sure the external runtime binaries are present and up to date (see
// ToolsManager.ensure).
export function ensureExternalResources(): Promise<void> {
  return tools().ensure();
}

// Settings' Update tools (see ToolsManager.update).
export function updateTools(): Promise<void> {
  return tools().update();
}

export function toolsStatus(): Omit<ToolsStatus, "problem" | "problemSince"> {
  return tools().status();
}
