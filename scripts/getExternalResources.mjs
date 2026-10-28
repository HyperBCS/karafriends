#!/usr/bin/node
import { execFile } from "child_process";
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

// The ASIO SDK is a Windows-only compile-time dependency of the native module.
async function getAsioSdk() {
  const asioHeader = `${buildResourcesDir}/asio/asiosdk/common/asio.h`;
  if (fs.existsSync(asioHeader)) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_asio"));
  const archive = path.join(tmpDir, "asio.zip");
  fs.mkdirSync(`${buildResourcesDir}/asio`, { recursive: true });
  try {
    await downloadFile("https://www.steinberg.net/asiosdk", archive);
    await execFileAsync(pathTo7zip, [
      "x",
      archive,
      "-y",
      `-o${buildResourcesDir}/asio`,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(asioHeader)) {
    console.error("The ASIO SDK wasn't successfully downloaded!");
    process.exit(1);
  }
}

copyExtractor();

if (process.platform === "win32") {
  await getAsioSdk();
}
