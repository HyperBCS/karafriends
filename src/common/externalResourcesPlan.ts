import path from "path";

import type { ToolStatus } from "./api";

// Pure, dependency-free planning and decision logic for the external runtime
// binaries. It is kept separate from externalResources.ts (which touches
// electron, the filesystem and the network) so the cross-platform behaviour can
// be unit tested without any of those side effects.

export type Platform = NodeJS.Platform;

export interface ResourcePaths {
  // Path to the ffmpeg executable
  ffmpeg: string;
  // Path to the ytdlp executable
  ytdlp: string;
}

// versions.json: each downloaded tool's version, when it was downloaded (ms
// since the epoch), from which URL, and the SHA-256 it matched. (Older
// versions kept HTTP validators there too, which are ignored now, and some
// didn't record the URL.)
export type Versions = Record<
  string,
  {
    version?: string;
    updatedAt?: number;
    url?: string;
    sha256?: string;
  }
>;

// Where a tool comes from, and what its download must match before it's
// unpacked or run.
export type Source =
  // One build, pinned: a URL that keeps serving the same file, and that
  // file's SHA-256. A new build comes with a new karafriends.
  | { kind: "pinned"; url: string; sha256: string }
  // The latest release of a GitHub repository. "latest" is resolved to the
  // release's tag first, and the file and the release's checksums file both
  // come from that tag: a release published meanwhile can't mix them up.
  | { kind: "latestRelease"; repo: string; asset: string; sums: string };

// One extraction pass: unpack `input` (relative to the temp dir) into `outDir`
// (relative to the temp dir). Archives that need multiple passes (e.g. .tar.xz)
// list several steps, each consuming a file produced by the previous one.
export interface ExtractStep {
  input: string;
  outDir: string;
  // Only this file name, from any folder in the archive. Unset: everything.
  only?: string;
}

export type Download =
  | { kind: "binary" }
  | {
      kind: "archive";
      // Temp filename to stream the downloaded archive into.
      archiveName: string;
      steps: ExtractStep[];
      // Path of the extracted binary, relative to the temp dir.
      binary: string;
    };

export interface AssetPlan {
  id: "ytdlp" | "ffmpeg";
  source: Source;
  dest: string;
  download: Download;
}

// Environment variables that point a tool at another copy (a test's fake,
// or a host's own build). karafriends then never downloads that tool.
export const TOOL_PATH_ENV = {
  ytdlp: "KARAFRIENDS_YTDLP_PATH",
  ffmpeg: "KARAFRIENDS_FFMPEG_PATH",
} as const satisfies Record<AssetPlan["id"], string>;

// The tools env overrides, by id. An empty value counts as unset.
export function toolOverrides(
  env: Record<string, string | undefined>,
): Partial<ResourcePaths> {
  const overrides: Partial<ResourcePaths> = {};
  for (const [id, name] of Object.entries(TOOL_PATH_ENV) as [
    AssetPlan["id"],
    string,
  ][]) {
    const value = env[name]?.trim();
    if (value) overrides[id] = path.resolve(value);
  }
  return overrides;
}

// The version a tool prints: yt-dlp --version "2026.10.01", ffmpeg -version
// "ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) ...".
// Null if it printed nothing.
export function parseToolVersion(output: string): string | null {
  const firstLine = output.trim().split(/\r?\n/)[0].trim();
  const afterVersion = firstLine.match(/\bversion (\S+)/);
  return afterVersion ? afterVersion[1] : firstLine.split(/\s+/)[0] || null;
}

// One tool's status for the settings screen. An overridden tool is never
// downloaded, so it has no updatedAt, and its version is the one it gave at
// this launch's check.
export function toolStatus(
  id: AssetPlan["id"],
  stored: Versions,
  overrides: Partial<ResourcePaths>,
  overrideVersions: Partial<Record<AssetPlan["id"], string | null>>,
): ToolStatus {
  if (overrides[id] !== undefined) {
    return {
      version: overrideVersions[id] ?? null,
      updatedAt: null,
      overridden: true,
    };
  }
  return {
    version: stored[id]?.version ?? null,
    updatedAt: stored[id]?.updatedAt ?? null,
    overridden: false,
  };
}

// A cached copy whose source wasn't recorded (an old karafriends', or a
// test's stand-in) is kept this long after it was written, then replaced
// by a checked download.
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// yt-dlp has to keep up with YouTube, so it's the latest release, checked
// at every launch against the release's own SHA2-256SUMS.
const YTDLP_REPO = "yt-dlp/yt-dlp";

function ytdlpRelease(asset: string): Source {
  return {
    kind: "latestRelease",
    repo: YTDLP_REPO,
    asset,
    sums: "SHA2-256SUMS",
  };
}

// The ffmpeg builds, pinned: a new upstream build can't break the app or
// reach it unchecked. Each URL is a release its host keeps, and each
// SHA-256 was taken from a download and matched the host's own. To move to
// another build, change both, on purpose. All are GPL builds.
export const FFMPEG_BUILDS = {
  // Gyan Doshi's full build of FFmpeg 9.0.2, from his GitHub mirror of
  // gyan.dev. The mirror keeps every release (back to 4.4, from 2021);
  // gyan.dev itself removes old ones.
  win32: {
    kind: "pinned",
    url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.7z",
    sha256: "f0e46253c70dfe902bac915dfb4224f0cf1b7c6eeab9da2ccc9a5581f9a71b13",
  },
  // Martin Riedl's static build of FFmpeg 9.0.2 for Apple Silicon, signed
  // (which Apple Silicon requires of arm64 code). (karafriends isn't built
  // for Intel Macs.) His release builds stay at their versioned URLs (5.0's,
  // from 2022, still download). The zip holds just the ffmpeg binary.
  darwinArm64: {
    kind: "pinned",
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
  },
  // Jellyfin's portable build of FFmpeg 8.1.3 (FFmpeg with Jellyfin's
  // patches, built with BtbN's scripts: static, for glibc 2.28 or newer).
  // Jellyfin keeps every release on GitHub (back to 2019). No 9.x build
  // stays put: BtbN deletes its builds within two years, and
  // martin-riedl.de's Linux build isn't GPL (it's "nonfree").
  linuxX64: {
    kind: "pinned",
    url: "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_linux64-gpl.tar.xz",
    sha256: "b86dc023c64a5a9a410e6e3a938a970460214fae78f31c1553c9f88f1c289b6a",
  },
  linuxArm64: {
    kind: "pinned",
    url: "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_linuxarm64-gpl.tar.xz",
    sha256: "7bc8e8d0986f7f4693f63e9728570f671f07b6e21c05d5465dd7ce461d1631dc",
  },
} as const satisfies Record<string, Source>;

// Where a repository's latest release is: it redirects to the release's
// page, .../releases/tag/<tag>.
export function latestReleaseUrl(repo: string): string {
  return `https://github.com/${repo}/releases/latest`;
}

// The tag in where latestReleaseUrl redirected (location, as the Location
// header gave it). Null if it isn't one of repo's release pages.
export function releaseTag(
  location: string | null,
  repo: string,
): string | null {
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location, "https://github.com/");
  } catch {
    return null;
  }
  const prefix = `/${repo}/releases/tag/`.toLowerCase();
  if (
    url.hostname !== "github.com" ||
    !url.pathname.toLowerCase().startsWith(prefix)
  ) {
    return null;
  }
  const tag = decodeURIComponent(url.pathname.slice(prefix.length));
  return tag !== "" && !tag.includes("/") ? tag : null;
}

// A file of one release.
export function releaseAssetUrl(
  repo: string,
  tag: string,
  name: string,
): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

// A file's SHA-256 (in lower case) from a checksums file as sha256sum
// writes it: "<hex>  <name>" a line, or "<hex> *<name>". Null if the file
// isn't listed.
export function sha256FromSums(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

export function extractorFileName(platform: Platform): string {
  return platform === "win32" ? "7za.exe" : "7za";
}

export function resourcePathsFor(
  platform: Platform,
  cacheDir: string,
): ResourcePaths {
  const ffmpegName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ytdlpName =
    platform === "win32"
      ? "yt-dlp.exe"
      : platform === "darwin"
        ? "yt-dlp_macos"
        : "yt-dlp";
  return {
    ffmpeg: path.join(cacheDir, "ffmpeg", ffmpegName),
    ytdlp: path.join(cacheDir, "ytdlp", ytdlpName),
  };
}

// The downloadable assets for a platform and CPU architecture (process.arch):
// where each comes from, its final destination, and how (if at all) its
// download is unpacked.
export function assetPlans(
  platform: Platform,
  arch: string,
  paths: ResourcePaths,
): AssetPlan[] {
  switch (platform) {
    case "win32":
      return [
        {
          id: "ytdlp",
          source: ytdlpRelease("yt-dlp.exe"),
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          source: FFMPEG_BUILDS.win32,
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.7z",
            steps: [{ input: "ffmpeg.7z", outDir: "out", only: "ffmpeg.exe" }],
            binary: path.join("out", "ffmpeg.exe"),
          },
        },
      ];
    case "darwin":
      return [
        {
          id: "ytdlp",
          source: ytdlpRelease("yt-dlp_macos"),
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          source: FFMPEG_BUILDS.darwinArm64,
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.zip",
            steps: [{ input: "ffmpeg.zip", outDir: "out", only: "ffmpeg" }],
            binary: path.join("out", "ffmpeg"),
          },
        },
      ];
    default:
      return [
        {
          id: "ytdlp",
          // The standalone build, which brings its own Python. The plain
          // yt-dlp is a zipapp run by the system's python3, and it needs
          // 3.11 or later: Ubuntu 22.04 has 3.10, and some hosts have none.
          // The file keeps the name yt-dlp.
          source: ytdlpRelease(
            `yt-dlp_linux${arch === "arm64" ? "_aarch64" : ""}`,
          ),
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          source:
            arch === "arm64"
              ? FFMPEG_BUILDS.linuxArm64
              : FFMPEG_BUILDS.linuxX64,
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.tar.xz",
            // .tar.xz needs two passes: first to the .tar, then to the contents.
            steps: [
              { input: "ffmpeg.tar.xz", outDir: "tar" },
              // Just ffmpeg: not ffprobe too.
              {
                input: path.join("tar", "ffmpeg.tar"),
                outDir: "out",
                only: "ffmpeg",
              },
            ],
            binary: path.join("out", "ffmpeg"),
          },
        },
      ];
  }
}

export function isStale(
  mtimeMs: number,
  nowMs: number,
  staleMs: number = STALE_MS,
): boolean {
  return nowMs - mtimeMs > staleMs;
}

// Whether the cached copy stays without asking the network: it's the
// pinned build the source names, or its source wasn't recorded and it's
// fresh (see STALE_MS). A latest release has to be asked which release is
// latest. (Update tools always downloads.)
export function cachedCopyStays(
  exists: boolean,
  stored: Versions[string] | undefined,
  source: Source,
  mtimeMs: number,
  nowMs: number,
): boolean {
  if (!exists) return false;
  if (stored?.url === undefined) return !isStale(mtimeMs, nowMs);
  return source.kind === "pinned" && stored.url === source.url;
}
