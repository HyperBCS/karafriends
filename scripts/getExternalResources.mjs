#!/usr/bin/node
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import sevenBin from "7zip-bin";
import promiseRetry from "promise-retry";

// The large media binaries are downloaded lazily at runtime and cached on the
// user's machine (see src/common/externalResources.ts), so they are no longer
// fetched at build time. This script only prepares build-time resources:
//   * the archive extractor, copied into extraResources/ so it ships with the
//     app and can unpack the runtime downloads
//   * the Windows ASIO SDK, a compile-time dependency of the native module

const execFileAsync = promisify(execFile);

const pathTo7zip = sevenBin.path7za;
// 7zip-bin's macOS `7za` binaries ship without the executable bit, so
// spawning one (packager.js zips with it) fails with EACCES. Restore the
// executable bit. (No-op on Windows, and harmless where it's already set.)
if (process.platform !== "win32") {
  try {
    fs.chmodSync(pathTo7zip, 0o755);
  } catch {
    // best-effort; extraction will surface a clearer error if this fails
  }
}

const extraResourcesDir = `${process.cwd()}/extraResources`;
const buildResourcesDir = `${process.cwd()}/buildResources`;

// How long one try at a download may take, body included. Without it, a
// server that accepts the connection and then goes quiet hangs the build.
const DOWNLOAD_TIMEOUT_MS = 120_000;

// Downloads url to dest, with Node's fetch, retried with backoff. Some
// hosts reset the connection instead of answering with an error, so a
// thrown error is retried too: promise-retry by itself only retries what is
// passed to retry(). A write error (a full disk, say) fails at once.
async function downloadFile(url, dest) {
  const body = await promiseRetry(
    async (retry) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`${res.status} from ${url}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return retry(err);
      }
    },
    { retries: 5, factor: 2, minTimeout: 1000 },
  );
  fs.writeFileSync(dest, body);
}

// Copy the archive extractor into extraResources/ so it ships with the app and
// can unpack the runtime downloads. Uses the host architecture, which is what
// runs in development and on the per-arch CI machines; the packager copies the
// target-architecture extractor for production builds.
function copyExtractor() {
  fs.mkdirSync(extraResourcesDir, { recursive: true });
  const dest = path.join(
    extraResourcesDir,
    process.platform === "win32" ? "7za.exe" : "7za",
  );
  fs.copyFileSync(pathTo7zip, dest);
  if (process.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
}

// The ASIO SDK, pinned: the zip of one version, and its SHA-256.
// https://www.steinberg.net/asiosdk redirects to whichever is newest, so the
// version's own file is named here. 2.3.4 is the first offered under GPLv3
// too. To move to another SDK, check its licence, and change both on purpose.
const ASIO_SDK = {
  url: "https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip",
  sha256: "d5ebf0c20dd2c5f43771fd0c1418f4b361bf52434ee670097cfa6b3a335e2eca",
};

// What to do when the pinned SDK can't be had.
const ASIO_SDK_HELP =
  "If Steinberg changed or removed it, get the current SDK from " +
  "https://www.steinberg.net/asiosdk, check it and its licence, and update " +
  "ASIO_SDK (its URL and SHA-256) in scripts/getExternalResources.mjs on " +
  "purpose. Or put an SDK in buildResources/asio yourself.";

// The ASIO SDK is a Windows-only compile-time dependency of the native module.
// Exits with the reason if it can't be had.
async function getAsioSdk() {
  const asioHeader = `${buildResourcesDir}/asio/asiosdk/common/asio.h`;
  if (fs.existsSync(asioHeader)) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_asio"));
  const archive = path.join(tmpDir, "asio.zip");
  fs.mkdirSync(`${buildResourcesDir}/asio`, { recursive: true });
  let problem = null;
  try {
    await downloadFile(ASIO_SDK.url, archive);
    // Before it's unpacked.
    const sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(archive))
      .digest("hex");
    if (sha256 !== ASIO_SDK.sha256) {
      problem =
        `The ASIO SDK from ${ASIO_SDK.url} has SHA-256 ${sha256}, not the ` +
        `pinned ${ASIO_SDK.sha256}, so it wasn't used.`;
    } else {
      await execFileAsync(pathTo7zip, [
        "x",
        archive,
        "-y",
        `-o${buildResourcesDir}/asio`,
      ]);
    }
  } catch (err) {
    problem = `Couldn't get the ASIO SDK from ${ASIO_SDK.url}: ${err}`;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (problem === null && !fs.existsSync(asioHeader)) {
    problem = `The ASIO SDK from ${ASIO_SDK.url} has no common/asio.h.`;
  }
  if (problem !== null) {
    console.error(`${problem}\n${ASIO_SDK_HELP}`);
    process.exit(1);
  }
}

copyExtractor();

if (process.platform === "win32") {
  await getAsioSdk();
}
