// This file runs on Node's built-in test runner, not through the app bundle, so
// it uses node: core modules directly.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import {
  assetPlans,
  cachedCopyStays,
  extractorFileName,
  FFMPEG_BUILDS,
  isStale,
  latestReleaseUrl,
  parseToolVersion,
  releaseAssetUrl,
  releaseTag,
  resourcePathsFor,
  sha256FromSums,
  STALE_MS,
  toolOverrides,
  toolStatus,
  type AssetPlan,
  type Platform,
  type Source,
} from "./externalResourcesPlan";

const PLATFORMS: Platform[] = ["win32", "darwin", "linux"];

// Per-platform expectations. These encode the cross-platform contract: the
// binary filenames, where each tool comes from, and the unpacking each OS
// needs.
const EXPECT: Record<
  string,
  {
    extractor: string;
    ffmpeg: string;
    ytdlp: string;
    // The yt-dlp release asset.
    ytdlpAsset: string;
    ffmpegUrl: string;
    archiveName: string;
    steps: number;
    binary: string[];
  }
> = {
  win32: {
    extractor: "7za.exe",
    ffmpeg: "ffmpeg.exe",
    ytdlp: "yt-dlp.exe",
    ytdlpAsset: "yt-dlp.exe",
    // gyan.dev's full build, from its GitHub mirror, which keeps releases.
    ffmpegUrl:
      "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.7z",
    archiveName: "ffmpeg.7z",
    steps: 1,
    binary: ["out", "ffmpeg.exe"],
  },
  darwin: {
    extractor: "7za",
    ffmpeg: "ffmpeg",
    ytdlp: "yt-dlp_macos",
    ytdlpAsset: "yt-dlp_macos",
    // Martin Riedl's signed static build for Apple Silicon, the only Mac
    // karafriends is built for.
    ffmpegUrl:
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    archiveName: "ffmpeg.zip",
    steps: 1,
    binary: ["out", "ffmpeg"],
  },
  linux: {
    extractor: "7za",
    ffmpeg: "ffmpeg",
    ytdlp: "yt-dlp",
    // The standalone build: the plain yt-dlp is a Python zipapp that needs
    // Python 3.11 or later, which Ubuntu 22.04 doesn't have.
    ytdlpAsset: "yt-dlp_linux",
    ffmpegUrl:
      "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_linux64-gpl.tar.xz",
    archiveName: "ffmpeg.tar.xz",
    steps: 2,
    binary: ["out", "ffmpeg"],
  },
};

function pinned(plan: AssetPlan): Extract<Source, { kind: "pinned" }> {
  assert.equal(plan.source.kind, "pinned", plan.id);
  return plan.source as Extract<Source, { kind: "pinned" }>;
}

function latestRelease(
  plan: AssetPlan,
): Extract<Source, { kind: "latestRelease" }> {
  assert.equal(plan.source.kind, "latestRelease", plan.id);
  return plan.source as Extract<Source, { kind: "latestRelease" }>;
}

describe("extractorFileName", () => {
  test("uses the .exe extractor on Windows and the bare name elsewhere", () => {
    assert.equal(extractorFileName("win32"), "7za.exe");
    assert.equal(extractorFileName("darwin"), "7za");
    assert.equal(extractorFileName("linux"), "7za");
  });
});

describe("resourcePathsFor", () => {
  for (const platform of PLATFORMS) {
    test(`resolves cached binary paths for ${platform}`, () => {
      const cacheDir = path.join("cache", "dir");
      const paths = resourcePathsFor(platform, cacheDir);
      const expected = EXPECT[platform];

      assert.equal(
        paths.ffmpeg,
        path.join(cacheDir, "ffmpeg", expected.ffmpeg),
      );
      assert.equal(paths.ytdlp, path.join(cacheDir, "ytdlp", expected.ytdlp));
    });
  }
});

describe("toolOverrides", () => {
  test("takes KARAFRIENDS_YTDLP_PATH and KARAFRIENDS_FFMPEG_PATH, made absolute", () => {
    const ytdlp = path.resolve("tests", "fixtures", "bin", "yt-dlp-fails.cmd");
    assert.deepEqual(
      toolOverrides({
        KARAFRIENDS_YTDLP_PATH: path.join(
          "tests",
          "fixtures",
          "bin",
          "yt-dlp-fails.cmd",
        ),
        KARAFRIENDS_FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg",
        PATH: "/usr/bin",
      }),
      { ytdlp, ffmpeg: path.resolve("/opt/ffmpeg/bin/ffmpeg") },
    );
  });

  test("ignores unset and empty ones", () => {
    assert.deepEqual(toolOverrides({}), {});
    assert.deepEqual(
      toolOverrides({
        KARAFRIENDS_YTDLP_PATH: " ",
        KARAFRIENDS_FFMPEG_PATH: "",
      }),
      {},
    );
  });
});

describe("assetPlans", () => {
  for (const platform of PLATFORMS) {
    const expected = EXPECT[platform];
    const paths = resourcePathsFor(platform, path.join("cache", "dir"));
    const plans = assetPlans(platform, "x64", paths);

    test(`${platform}: has a ytdlp binary asset and an ffmpeg archive asset`, () => {
      assert.deepEqual(
        plans.map((p) => p.id),
        ["ytdlp", "ffmpeg"],
      );
    });

    test(`${platform}: plan destinations match resourcePathsFor`, () => {
      const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
      assert.equal(byId.ytdlp.dest, paths.ytdlp);
      assert.equal(byId.ffmpeg.dest, paths.ffmpeg);
    });

    test(`${platform}: ytdlp is the latest release's binary, checked against its SHA2-256SUMS`, () => {
      const ytdlp = plans.find((p) => p.id === "ytdlp")!;
      assert.equal(ytdlp.download.kind, "binary");
      assert.deepEqual(latestRelease(ytdlp), {
        kind: "latestRelease",
        repo: "yt-dlp/yt-dlp",
        asset: expected.ytdlpAsset,
        sums: "SHA2-256SUMS",
      });
    });

    test(`${platform}: ffmpeg is an archive unpacked to the ffmpeg binary`, () => {
      const ffmpeg = plans.find((p) => p.id === "ffmpeg")!;
      assert.equal(pinned(ffmpeg).url, expected.ffmpegUrl);
      assert.equal(ffmpeg.download.kind, "archive");

      if (ffmpeg.download.kind !== "archive") return; // narrow for the type checker
      const dl = ffmpeg.download;

      assert.equal(dl.archiveName, expected.archiveName);
      assert.equal(dl.steps.length, expected.steps);
      assert.equal(dl.binary, path.join(...expected.binary));

      // The first pass consumes the downloaded archive, and the final pass
      // produces the directory the binary is read from.
      assert.equal(dl.steps[0].input, dl.archiveName);
      assert.equal(
        dl.steps[dl.steps.length - 1].outDir,
        path.dirname(dl.binary),
      );
    });

    test(`${platform}: ffmpeg is pinned to one https URL and its SHA-256`, () => {
      const ffmpeg = pinned(plans.find((p) => p.id === "ffmpeg")!);
      assert.ok(ffmpeg.url.startsWith("https://"), ffmpeg.url);
      assert.match(ffmpeg.sha256, /^[0-9a-f]{64}$/);
    });
  }
});

describe("assetPlans by architecture", () => {
  const plan = (platform: Platform, arch: string, id: "ytdlp" | "ffmpeg") =>
    assetPlans(
      platform,
      arch,
      resourcePathsFor(platform, path.join("cache", "dir")),
    ).find((p) => p.id === id)!;

  test("linux arm64 gets the aarch64 standalone yt-dlp, under the same name", () => {
    const ytdlp = plan("linux", "arm64", "ytdlp");
    assert.equal(latestRelease(ytdlp).asset, "yt-dlp_linux_aarch64");
    assert.equal(path.basename(ytdlp.dest), "yt-dlp");
  });

  test("a Mac gets the Apple Silicon ffmpeg", () => {
    assert.equal(
      pinned(plan("darwin", "arm64", "ffmpeg")).url,
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    );
    // yt-dlp_macos is a universal binary.
    assert.deepEqual(
      plan("darwin", "arm64", "ytdlp").source,
      plan("darwin", "x64", "ytdlp").source,
    );
  });

  test("every ffmpeg is pinned: a versioned URL, never a moving one", () => {
    const builds: Source[] = Object.values(FFMPEG_BUILDS);
    for (const build of builds) {
      assert.equal(build.kind, "pinned");
      if (build.kind !== "pinned") continue; // narrow for the type checker
      assert.doesNotMatch(build.url, /latest|master|redirect/, build.url);
      assert.match(build.sha256, /^[0-9a-f]{64}$/, build.url);
    }
    for (const platform of PLATFORMS) {
      for (const arch of ["x64", "arm64"]) {
        const ffmpeg = plan(platform, arch, "ffmpeg");
        assert.ok(builds.includes(ffmpeg.source), `${platform} ${arch}`);
      }
    }
  });

  test("linux arm64 gets the arm64 ffmpeg", () => {
    assert.match(
      pinned(plan("linux", "arm64", "ffmpeg")).url,
      /_linuxarm64-gpl\./,
    );
  });

  test("no Linux plan downloads the Python zipapp", () => {
    for (const arch of ["x64", "arm64"]) {
      assert.match(
        latestRelease(plan("linux", arch, "ytdlp")).asset,
        /^yt-dlp_linux/,
      );
    }
  });
});

describe("latest releases", () => {
  const repo = "yt-dlp/yt-dlp";

  test("are found where 'latest' redirects", () => {
    assert.equal(
      latestReleaseUrl(repo),
      "https://github.com/yt-dlp/yt-dlp/releases/latest",
    );
    assert.equal(
      releaseTag(
        "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26",
        repo,
      ),
      "2026.10.26",
    );
    // A relative Location, and the repo's name in another case.
    assert.equal(
      releaseTag("/YT-DLP/yt-dlp/releases/tag/2026.10.26", repo),
      "2026.10.26",
    );
  });

  test("anything but a release page of the repo has no tag", () => {
    for (const location of [
      null,
      "",
      "https://github.com/yt-dlp/yt-dlp/releases",
      "https://github.com/yt-dlp/yt-dlp/releases/tag/",
      "https://github.com/other/yt-dlp/releases/tag/2026.10.26",
      "https://example.com/yt-dlp/yt-dlp/releases/tag/2026.10.26",
      "https://github.com/login?return_to=%2Fyt-dlp",
    ]) {
      assert.equal(releaseTag(location, repo), null, String(location));
    }
  });

  test("a release's files come from its tag", () => {
    assert.equal(
      releaseAssetUrl(repo, "2026.10.26", "SHA2-256SUMS"),
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS",
    );
  });
});

describe("sha256FromSums", () => {
  const sums =
    "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  yt-dlp\n" +
    "F5389D3698ECDE4EF06F4E6B1CE0294FE9AC1396228C8990B8D3416D6D177A7D  yt-dlp.exe\r\n" +
    "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795 *yt-dlp_linux\n" +
    "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483  yt-dlp_linux_aarch64\n";

  test("finds a file's checksum by its whole name, in lower case", () => {
    assert.equal(
      sha256FromSums(sums, "yt-dlp"),
      "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3",
    );
    assert.equal(
      sha256FromSums(sums, "yt-dlp.exe"),
      "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
    );
    assert.equal(
      sha256FromSums(sums, "yt-dlp_linux"),
      "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795",
    );
  });

  test("is null for a file that isn't listed, or a line that isn't a checksum", () => {
    assert.equal(sha256FromSums(sums, "yt-dlp_macos"), null);
    assert.equal(sha256FromSums("", "yt-dlp"), null);
    assert.equal(sha256FromSums("abc  yt-dlp\n", "yt-dlp"), null);
  });
});

describe("cachedCopyStays", () => {
  const now = 100 * STALE_MS;
  const build: Source = {
    kind: "pinned",
    url: "https://example.com/ffmpeg-9.0.2.7z",
    sha256: "0".repeat(64),
  };
  const release: Source = {
    kind: "latestRelease",
    repo: "yt-dlp/yt-dlp",
    asset: "yt-dlp.exe",
    sums: "SHA2-256SUMS",
  };

  test("a missing copy never stays", () => {
    assert.equal(
      cachedCopyStays(false, { url: build.url }, build, now, now),
      false,
    );
    assert.equal(cachedCopyStays(false, undefined, build, now, now), false);
  });

  test("the pinned build stays; another build's copy is replaced", () => {
    assert.equal(
      cachedCopyStays(true, { url: build.url }, build, 0, now),
      true,
    );
    assert.equal(
      cachedCopyStays(
        true,
        { url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z" },
        build,
        now,
        now,
      ),
      false,
    );
  });

  test("a latest release is always asked which release is latest", () => {
    const url =
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe";
    assert.equal(cachedCopyStays(true, { url }, release, now, now), false);
  });

  test("a copy whose source wasn't recorded stays only while fresh", () => {
    for (const source of [build, release]) {
      assert.equal(cachedCopyStays(true, undefined, source, now, now), true);
      assert.equal(cachedCopyStays(true, {}, source, now - 1, now), true);
      assert.equal(
        cachedCopyStays(true, { version: "7.1" }, source, 0, now),
        false,
      );
    }
  });
});

describe("isStale", () => {
  test("is a one week window", () => {
    assert.equal(STALE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  test("is true only once older than the window", () => {
    const now = 10 * STALE_MS;
    assert.equal(isStale(now - STALE_MS - 1, now), true);
    assert.equal(isStale(now - STALE_MS, now), false);
    assert.equal(isStale(now - 1, now), false);
    assert.equal(isStale(now, now), false);
  });

  test("honours a custom window", () => {
    assert.equal(isStale(0, 100, 50), true);
    assert.equal(isStale(60, 100, 50), false);
  });
});

describe("parseToolVersion", () => {
  test("reads yt-dlp's date", () => {
    assert.equal(parseToolVersion("2026.10.01\n"), "2026.10.01");
    assert.equal(
      parseToolVersion("2026.10.01.232716\r\n"),
      "2026.10.01.232716",
    );
  });

  test("reads the token after ffmpeg's 'version'", () => {
    assert.equal(
      parseToolVersion(
        "ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers\r\n" +
          "built with gcc 14.2.0 (Rev1, Built by MSYS2 project)\r\n",
      ),
      "7.1-full_build-www.gyan.dev",
    );
    assert.equal(
      parseToolVersion(
        "ffmpeg version N-117000-gabcdef0-20241020 Copyright (c) 2000-2024\n",
      ),
      "N-117000-gabcdef0-20241020",
    );
    assert.equal(
      parseToolVersion("ffmpeg version 6.1.1 Copyright (c) 2000-2023\n"),
      "6.1.1",
    );
  });

  test("is null for no output", () => {
    assert.equal(parseToolVersion(""), null);
    assert.equal(parseToolVersion(" \r\n"), null);
  });
});

describe("toolStatus", () => {
  const stored = {
    ytdlp: {
      version: "2026.10.01",
      url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.01/yt-dlp.exe",
    },
    ffmpeg: {
      url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
    },
  };

  test("a downloaded tool: its recorded version", () => {
    assert.deepEqual(toolStatus("ytdlp", stored, {}, {}), {
      version: "2026.10.01",
      overridden: false,
    });
    // Cached before versions were recorded, and not asked yet.
    assert.deepEqual(toolStatus("ffmpeg", stored, {}, {}), {
      version: null,
      overridden: false,
    });
    assert.deepEqual(toolStatus("ffmpeg", {}, {}, {}), {
      version: null,
      overridden: false,
    });
  });

  test("an overridden tool: the version it gave", () => {
    const overrides = { ytdlp: "/opt/yt-dlp" };
    assert.deepEqual(
      toolStatus("ytdlp", stored, overrides, { ytdlp: "2026.11.02" }),
      { version: "2026.11.02", overridden: true },
    );
    // Not asked yet, or it couldn't say.
    assert.deepEqual(toolStatus("ytdlp", stored, overrides, {}), {
      version: null,
      overridden: true,
    });
    assert.deepEqual(toolStatus("ytdlp", stored, overrides, { ytdlp: null }), {
      version: null,
      overridden: true,
    });
    // The other tool is unaffected.
    assert.equal(toolStatus("ffmpeg", stored, overrides, {}).overridden, false);
  });
});
