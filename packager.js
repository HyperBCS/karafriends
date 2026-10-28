#!/usr/bin/env yarn node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const sevenBin = require("7zip-bin");
const { packager } = require("@electron/packager");

// Copy the archive extractor for the target architecture into extraResources/
// so it ships with the app and can unpack the runtime downloads. 7zip-bin lays
// its binaries out as <root>/<platform>/<arch>/7za[.exe]; path7za points at the
// host binary, so we derive the package root from it and pick the target arch.
function bundleExtractor() {
  const arch = process.env.PACKAGER_ARCH || process.arch;
  const platformDir = { darwin: "mac", win32: "win", linux: "linux" }[
    process.platform
  ];
  const binName = process.platform === "win32" ? "7za.exe" : "7za";
  const root = path.resolve(path.dirname(sevenBin.path7za), "..", "..");
  const src = path.join(root, platformDir, arch, binName);
  const dest = path.join("extraResources", binName);
  fs.mkdirSync("extraResources", { recursive: true });
  fs.copyFileSync(src, dest);
  if (process.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
}

(async () => {
  bundleExtractor();
  const buildFiles = new Set([
    "",
    "/package.json",
    "/build",
    // fs.globSync returns native separators; packager matches POSIX paths.
    ...fs
      .globSync("build/prod/**")
      .map((file) => `/${file.split(path.sep).join("/")}`),
  ]);
  const [output] = await packager({
    arch: process.env.PACKAGER_ARCH,
    // @electron/packager now defaults to an asar archive; keep the plain
    // resources/app folder the app has always shipped with.
    asar: false,
    dir: ".",
    extraResource: ["extraResources"],
    ignore: (path) => !buildFiles.has(path),
    out: "dist",
    overwrite: true,
    ...(process.platform === "darwin" && {
      appBundleId: "party.karafriends",
      icon: "appIcons/icon.icns",
      osxNotarize: {
        appleApiKey: process.env.NOTARIZATION_KEY_PATH,
        appleApiKeyId: "Z744X6G756",
        appleApiIssuer: "69a6de7c-6a99-47e3-e053-5b8c7c11a4d1",
      },
      osxSign: {
        identity: "Developer ID Application: Brandon Smith (JH8AT59Q63)",
      },
    }),
    ...(process.platform === "win32" && {
      icon: "appIcons/icon.ico",
    }),
  });
  console.log(`Built ${output}. Zipping...`);
  // `7za a` adds to an existing archive, so a zip left from an earlier run
  // would keep files this build doesn't have.
  const zip = `${output}.zip`;
  fs.rmSync(zip, { force: true });
  // From dist/, so the zip holds karafriends-<platform>-<arch>/ and not
  // dist/karafriends-<platform>-<arch>/.
  const zipped = spawnSync(
    sevenBin.path7za,
    ["a", "-r", path.basename(zip), path.basename(output)],
    { cwd: path.dirname(output), stdio: "inherit" },
  );
  // A 7za that couldn't start, or failed part way, fails the release.
  if (zipped.error) throw zipped.error;
  if (zipped.status !== 0) {
    throw new Error(
      `7za exited with ${zipped.status ?? zipped.signal} while zipping ${output}`,
    );
  }
  console.log(`Built ${zip}.`);
})();
