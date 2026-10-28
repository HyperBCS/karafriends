import { execFile } from "child_process";
import { app } from "electron";
import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import fetch, { Response as FetchResponse } from "node-fetch";

import type { ToolsStatus } from "./api";
import { toolCommand } from "./downloadFailure";
import {
  AssetPlan,
  assetPlans,
  canSkipUnvalidated,
  conditionalHeaders,
  extractorFileName,
  isStale,
  parseToolVersion,
  ResourcePaths,
  resourcePathsFor,
  TOOL_PATH_ENV,
  toolOverrides,
  toolStatus,
  Versions,
} from "./externalResourcesPlan";

const execFileAsync = promisify(execFile);

// External runtime binaries are downloaded lazily on the user's machine and
// cached here so they are fetched once and reused across launches, instead of
// being bundled into every build. They still need to stay current: the upstream
// tools update frequently (some are pinned to a "latest" release), so on each
// launch we ask the server whether a newer version exists and refresh only when
// it does. The archive extractor is the only piece that ships with the app (see
// extraResources), because we need it to unpack these downloads at runtime.
//
// The pure planning and decision logic lives in externalResourcesPlan.ts so it
// can be unit tested across platforms without electron, the filesystem, or the
// network; this module wires that plan up to the real side effects.
//
// The extractor is in the packaged app's resources. Unpackaged, it's in
// extraResources/ at the top of the repo, where the build copies it; this file
// is bundled into build/<prod|dev>/main.
const extractorDir = app.isPackaged
  ? path.join(process.resourcesPath, "extraResources")
  : path.join(__dirname, "..", "..", "..", "extraResources");

const extractorPath = path.join(
  extractorDir,
  extractorFileName(process.platform),
);

const cacheDir = path.join(app.getPath("userData"), "externalResources");
const versionsFile = path.join(cacheDir, "versions.json");

// KARAFRIENDS_YTDLP_PATH and KARAFRIENDS_FFMPEG_PATH, if set: those tools are
// used as they are, and never downloaded.
const overrides = toolOverrides(process.env);

const resourcePaths: ResourcePaths = {
  ...resourcePathsFor(process.platform, cacheDir),
  ...overrides,
};

for (const [id, file] of Object.entries(overrides)) {
  console.info(
    `Using ${file} for ${id} (${TOOL_PATH_ENV[id as keyof ResourcePaths]})`,
  );
}

export function getResourcePaths(): ResourcePaths {
  return resourcePaths;
}

function readVersions(): Versions {
  try {
    return JSON.parse(fs.readFileSync(versionsFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeVersions(versions: Versions): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(versionsFile, JSON.stringify(versions, null, 2));
}

// Fetch accepting both 200 (changed / first download) and 304 (unchanged), with
// exponential backoff. Some hosts (e.g. CDNs that rate-limit certain IPs) reset
// the connection instead of returning an HTTP error, so we retry on thrown
// network errors too, not just on non-ok responses.
async function fetchAsset(
  url: string,
  headers: Record<string, string>,
  retries: number,
): Promise<FetchResponse> {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    // Time out the request itself so a connection that hangs (rather than
    // erroring) doesn't stall forever. ensureExternalResources() is
    // single-flight, so one hung fetch would otherwise wedge every download.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.ok || res.status === 304) {
        return res;
      }
      lastError = new Error(String(res.status));
    } catch (error) {
      lastError = error;
    } finally {
      // Headers have arrived (or we failed); stop the timer so it can't abort
      // an in-progress body stream we're about to hand back for downloading.
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const DOWNLOAD_STALL_MS = 60000;

async function streamToFile(res: FetchResponse, dest: string): Promise<void> {
  const fileStream = fs.createWriteStream(dest);
  const body = res.body!;
  await new Promise<void>((resolve, reject) => {
    // Watchdog: if the body produces no data for DOWNLOAD_STALL_MS, treat it as
    // a stalled download and fail so the caller can retry instead of hanging.
    let stallTimer: ReturnType<typeof setTimeout>;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () =>
          (body as unknown as import("stream").Readable).destroy(
            new Error(`download stalled: ${dest}`),
          ),
        DOWNLOAD_STALL_MS,
      );
    };
    const settle = (fn: () => void) => {
      clearTimeout(stallTimer);
      fn();
    };
    armStall();
    body.on("data", armStall);
    body.pipe(fileStream);
    body.on("error", (err) => settle(() => reject(err)));
    fileStream.on("error", (err) => settle(() => reject(err)));
    fileStream.on("finish", () => settle(() => resolve()));
  });
}

// Move a finished binary into its final cached location atomically: write to a
// sibling temp file (same directory, so the rename stays on one filesystem) and
// rename into place last. An interrupted refresh therefore never leaves a file
// that looks complete, and never corrupts the copy already in use.
async function finalize(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await fsp.copyFile(src, partial);
  await fsp.rename(partial, dest);
}

async function extract(archive: string, outDir: string): Promise<void> {
  await execFileAsync(extractorPath, ["e", archive, "-y", `-o${outDir}`]);
}

// Download an asset into `tmpDir`, unpack it per its plan, and return the path
// of the finished binary to move into place.
async function materialize(
  plan: AssetPlan,
  tmpDir: string,
  res: FetchResponse,
): Promise<string> {
  if (plan.download.kind === "binary") {
    const bin = path.join(tmpDir, "bin");
    await streamToFile(res, bin);
    return bin;
  }

  const { archiveName, steps, binary } = plan.download;
  await streamToFile(res, path.join(tmpDir, archiveName));
  for (const step of steps) {
    await extract(
      path.join(tmpDir, step.input),
      path.join(tmpDir, step.outDir),
    );
  }
  return path.join(tmpDir, binary);
}

function mtimeMs(dest: string): number {
  try {
    return fs.statSync(dest).mtimeMs;
  } catch {
    return 0;
  }
}

// Make sure a single asset is present and up to date. Returns true when the
// cached copy changed (so the version metadata needs to be persisted).
// force: download it whatever the cache says, and fail if that fails (the
// cached copy stays).
async function ensureAsset(
  plan: AssetPlan,
  versions: Versions,
  force: boolean,
): Promise<boolean> {
  const exists = fs.existsSync(plan.dest);
  const stored = versions[plan.id];
  const stale = exists ? isStale(mtimeMs(plan.dest), Date.now()) : true;

  // Without a stored validator we cannot make a conditional request, so a plain
  // GET would re-download every launch. Skip until the cached copy is stale.
  if (!force && canSkipUnvalidated(exists, stored, stale)) {
    return false;
  }

  let res: FetchResponse;
  try {
    res = await fetchAsset(
      plan.url,
      force ? {} : conditionalHeaders(exists, stored),
      5,
    );
  } catch (err) {
    // Offline or the server is unreachable. Keep whatever we already have; only
    // fail if there is nothing cached to fall back on.
    if (exists && !force) {
      console.error(`Keeping cached ${plan.id}; version check failed: ${err}`);
      return false;
    }
    throw err;
  }

  if (res.status === 304) {
    return false;
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "karafriends_externalResources"),
  );
  try {
    const src = await materialize(plan, tmpDir, res);
    await finalize(src, plan.dest);
    if (process.platform !== "win32") {
      fs.chmodSync(plan.dest, 0o755);
    }
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
    updatedAt: Date.now(),
  };
  return true;
}

// What tool id at bin says its version is, or null if it can't say. ffmpeg
// takes -version; it refuses --version.
async function toolVersion(
  id: AssetPlan["id"],
  bin: string,
): Promise<string | null> {
  const command = toolCommand(bin, [
    id === "ffmpeg" ? "-version" : "--version",
  ]);
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      timeout: 30000,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    return parseToolVersion(stdout);
  } catch (err) {
    console.error(`Couldn't get the version of ${bin}: ${err}`);
    return null;
  }
}

// The overridden tools' versions, asked at each check.
const overrideVersions: Partial<Record<AssetPlan["id"], string | null>> = {};
let lastCheck: number | null = null;

async function doEnsure(force: boolean): Promise<void> {
  const plans = assetPlans(
    process.platform,
    process.arch,
    resourcePaths,
  ).filter((plan) => !(plan.id in overrides));
  const versions = readVersions();

  const results = await Promise.allSettled(
    plans.map((plan) => ensureAsset(plan, versions, force)),
  );
  let changed = results.some(
    (result) => result.status === "fulfilled" && result.value,
  );

  // Record the version of each tool just downloaded, or cached before
  // versions were recorded (their file's time stands in for the download's).
  // A tool that can't say is asked again next launch.
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
  if (
    !fs.existsSync(resourcePaths.ffmpeg) ||
    !fs.existsSync(resourcePaths.ytdlp)
  ) {
    throw new Error("An external resource wasn't successfully downloaded!");
  }
  lastCheck = Date.now();
}

let ensurePromise: Promise<void> | null = null;
let updatePromise: Promise<void> | null = null;

// Runs a check once any check in flight is done, and makes it the one
// downloads wait for. A failed check is cleared so a later call can retry,
// except a forced one that leaves both tools in place: downloads go on with the
// old copies, and only updateTools' caller sees the failure.
function check(force: boolean): Promise<void> {
  const previous = ensurePromise?.catch(() => {}) ?? Promise.resolve();
  const run = previous.then(() => doEnsure(force));
  const promise: Promise<void> = run.catch((err) => {
    if (
      force &&
      fs.existsSync(resourcePaths.ffmpeg) &&
      fs.existsSync(resourcePaths.ytdlp)
    ) {
      return;
    }
    if (ensurePromise === promise) ensurePromise = null;
    throw err;
  });
  ensurePromise = promise;
  if (!force) return promise;
  // The forced failure reaches updateTools' caller through run.
  promise.catch(() => {});
  return run;
}

// Make sure the external runtime binaries are present and up to date, fetching
// or refreshing them as needed. Runs its checks once per launch: concurrent and
// repeat calls within a launch share a single in-flight promise, and a failed
// attempt is cleared so a later call can retry.
export function ensureExternalResources(): Promise<void> {
  return ensurePromise ?? check(false);
}

// Settings' Update tools: downloads each tool that isn't overridden again,
// whatever the cache says, and records the versions. Rejects if a download
// failed; the copy in the cache stays.
export function updateTools(): Promise<void> {
  updatePromise ??= check(true).finally(() => {
    updatePromise = null;
  });
  return updatePromise;
}

// The tools' versions, and when they were last checked. (The problem is the
// live state's: services.ts adds it.)
export function toolsStatus(): Omit<ToolsStatus, "problem" | "problemSince"> {
  const stored = readVersions();
  return {
    ffmpeg: toolStatus("ffmpeg", stored, overrides, overrideVersions),
    ytdlp: toolStatus("ytdlp", stored, overrides, overrideVersions),
    lastCheck,
  };
}
