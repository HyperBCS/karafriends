#!/usr/bin/env node
// Prints CHANGELOG.md's section for package.json's version, without its
// heading: a release's notes (.github/workflows/release.yaml). Fails, saying
// so, if the CHANGELOG has no section for the version.
//
//   node scripts/releaseNotes.mjs > release-notes.md
import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");

// "## 0.2.0" or "## 0.2.0 (2026-10-29)", not "## 0.2.01".
const heading = new RegExp(
  `^## ${version.replaceAll(".", "\\.")}(?=[ (]|$)`,
  "m",
);
const start = changelog.search(heading);
if (start < 0) {
  console.error(
    `::error::CHANGELOG.md has no "## ${version}" section for the release's notes`,
  );
  process.exit(1);
}
const section = changelog.slice(start);
const body = section.slice(section.indexOf("\n") + 1);
const end = body.search(/^## /m);
process.stdout.write(`${(end < 0 ? body : body.slice(0, end)).trim()}\n`);
