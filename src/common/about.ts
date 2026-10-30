// About, in the display's Settings: where karafriends' source is, and the
// files the build puts beside the bundles in build/<prod|dev>/
// (scripts/thirdPartyNotices.ts writes them), which the main process reads
// for the display.

export const SOURCE_URL = "https://github.com/HyperBCS/karafriends";

// karafriends' license, and the third-party notices.
export const ABOUT_FILES = {
  license: "LICENSE.txt",
  notices: "THIRD_PARTY_NOTICES.txt",
} as const;

export type AboutText = keyof typeof ABOUT_FILES;

export function isAboutText(value: unknown): value is AboutText {
  return typeof value === "string" && Object.hasOwn(ABOUT_FILES, value);
}
