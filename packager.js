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

// Signed and notarized when the notarization key is given (the Release
// workflow always gives it); a local build without the Developer ID
// certificate is left unsigned, which runs on the building Mac. The key's
// ID and issuer can be given too (the Release workflow passes its secrets;
// without them, the ones the project was set up with), and the
// certificate's name if the keychain holds more than one.
function macSigning() {
  const keyPath = process.env.NOTARIZATION_KEY_PATH;
  if (!keyPath) {
    console.log("NOTARIZATION_KEY_PATH isn't set: the app is left unsigned.");
    return {};
  }
  // Otherwise the app is signed, then notarytool fails minutes later with
  // "The file couldn't be opened because it doesn't exist".
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `NOTARIZATION_KEY_PATH is ${keyPath}, which doesn't exist. ` +
        "Unset it for an unsigned build.",
    );
  }
  return {
    osxNotarize: {
      appleApiKey: keyPath,
      appleApiKeyId: process.env.NOTARIZATION_KEY_ID || "Z744X6G756",
      appleApiIssuer:
        process.env.NOTARIZATION_ISSUER_ID ||
        "69a6de7c-6a99-47e3-e053-5b8c7c11a4d1",
    },
    osxSign: {
      identity:
        // osx-sign takes the first certificate whose name contains this, and
        // the Release workflow's keychain holds just the one.
        process.env.MACOS_SIGNING_IDENTITY || "Developer ID Application",
      // The mics open in the display's renderer, whose preload loads the
      // native module. osx-sign gives a renderer helper only JIT, and under
      // the hardened runtime a process without the audio-input entitlement
      // hears nothing, so the renderer helper gets it too. Every other file
      // keeps osx-sign's defaults (the app's own include audio-input).
      optionsForFile: (filePath) =>
        filePath.includes("(Renderer).app")
          ? {
              entitlements: [
                "com.apple.security.cs.allow-jit",
                "com.apple.security.device.audio-input",
              ],
            }
          : undefined,
    },
  };
}

// Zips dist/karafriends-<platform>-<arch>/ into a .zip beside it, holding
// karafriends-<platform>-<arch>/ (not dist/...). On macOS with ditto, as
// Apple recommends: it keeps the app's framework symlinks and extended
// attributes, which a signed app's seal depends on. Elsewhere with the
// bundled 7za.
function zipFolder(output) {
  const zip = `${output}.zip`;
  // `7za a` adds to an existing archive, so a zip left from an earlier run
  // would keep files this build doesn't have.
  fs.rmSync(zip, { force: true });
  const [command, args] =
    process.platform === "darwin"
      ? [
          "ditto",
          [
            "-c",
            "-k",
            "--sequesterRsrc",
            "--keepParent",
            path.basename(output),
            path.basename(zip),
          ],
        ]
      : [
          sevenBin.path7za,
          ["a", "-r", path.basename(zip), path.basename(output)],
        ];
  const zipped = spawnSync(command, args, {
    cwd: path.dirname(output),
    stdio: "inherit",
  });
  // A zipper that couldn't start, or failed part way, fails the release.
  if (zipped.error) throw zipped.error;
  if (zipped.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited with ${zipped.status ?? zipped.signal} while zipping ${output}`,
    );
  }
  return zip;
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
      // What macOS says when it asks for the microphone.
      extendInfo: {
        NSMicrophoneUsageDescription:
          "karafriends plays your microphones through the speakers while you sing.",
      },
      ...macSigning(),
    }),
    ...(process.platform === "win32" && {
      icon: "appIcons/icon.ico",
    }),
  });
  console.log(`Built ${output}. Zipping...`);
  console.log(`Built ${zipFolder(output)}.`);
})();
