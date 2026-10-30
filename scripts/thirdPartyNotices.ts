// The notices that ship with the app, written beside the bundles in
// build/<prod|dev>/ (see electron.vite.config.ts):
//   LICENSE.txt               karafriends' own license, the GNU GPL v3
//   THIRD_PARTY_NOTICES.txt   the work of others the app is built with, and
//                             their licenses
//
// The notices list:
//   - the npm packages whose code went into the bundles (main, preload, the
//     two pages and their workers), as the bundler reports them, and what
//     their own builds carry (EMBEDDED)
//   - the Rust crates linked into the native module for the platform built
//     for (cargo metadata), the Rust standard library, and on Windows the
//     ASIO SDK
//   - what was copied into the repo: the lyrics fonts, the remote's icons,
//     the kuromoji dictionary
//   - the 7za beside the app (packager.js copies it from 7zip-bin)
// and say where Electron's own notices are, and that ffmpeg and yt-dlp
// aren't shipped.
//
// Each license must be one a GPLv3 program can ship (GPL3_COMPATIBLE): a
// package with no license, another one, or no license text fails the build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

import { ABOUT_FILES, SOURCE_URL } from "../src/common/about";

const { license: LICENSE_FILE, notices: NOTICES_FILE } = ABOUT_FILES;

// SPDX ids of the licenses whose work a GPLv3 program can include. The
// last three are for fonts, icons and data, not code.
export const GPL3_COMPATIBLE: ReadonlySet<string> = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "OFL-1.1",
  "CC-BY-4.0",
  // mecab-ipadic's own terms (NAIST's and ICOT's): copy and change it
  // freely, keeping the notice and the no-warranty text.
  "LicenseRef-IPADIC",
]);

// One license file, or one of scripts/licenses' texts for a package that
// ships none.
export interface LicenseText {
  // The file's name, or the license's id.
  name: string;
  text: string;
}

// Something the app is built with.
export interface Component {
  name: string;
  version?: string;
  // An SPDX expression.
  license: string;
  url?: string;
  // Lines under its name: a copyright, an attribution, where its source is.
  notes?: string[];
  texts: LicenseText[];
}

// A license expression, read: an id (with its exception, if any), or two
// joined by AND or OR.
export type LicenseExpression =
  | { id: string; exception?: string }
  | { op: "AND" | "OR"; left: LicenseExpression; right: LicenseExpression };

const OPERATOR = /^(AND|OR|WITH|\(|\))$/i;

// Reads an SPDX expression ("MIT OR Apache-2.0", "(MIT OR Apache-2.0) AND
// Unicode-3.0"); Cargo's old "MIT/Apache-2.0" means either. Throws on one
// it can't read.
export function parseLicense(expression: string): LicenseExpression {
  const tokens = expression
    .replace(/\//g, " OR ")
    .replace(/[()]/g, " $& ")
    .split(/\s+/)
    .filter(Boolean);
  let at = 0;
  const fail = (): never => {
    throw new Error(`Can't read the license "${expression}"`);
  };
  const next = () => tokens[at]?.toUpperCase();
  const either = (): LicenseExpression => {
    let left = both();
    while (next() === "OR") {
      at++;
      left = { op: "OR", left, right: both() };
    }
    return left;
  };
  const both = (): LicenseExpression => {
    let left = one();
    while (next() === "AND") {
      at++;
      left = { op: "AND", left, right: one() };
    }
    return left;
  };
  const one = (): LicenseExpression => {
    const token = tokens[at++];
    if (token === "(") {
      const inner = either();
      if (tokens[at++] !== ")") fail();
      return inner;
    }
    if (!token || OPERATOR.test(token)) return fail();
    if (next() !== "WITH") return { id: token };
    at++;
    const exception = tokens[at++];
    if (!exception || OPERATOR.test(exception)) fail();
    return { id: token, exception };
  };
  const parsed = either();
  if (at !== tokens.length) fail();
  return parsed;
}

// An id as SPDX spells it, for ids match whatever their case ("zlib" is
// Zlib), with "+" as "-or-later".
function spdxId(id: string, known: Iterable<string> = GPL3_COMPATIBLE) {
  const plain = id.replace(/\+$/, "-or-later");
  const lower = plain.toLowerCase();
  for (const knownId of known) {
    if (knownId.toLowerCase() === lower) return knownId;
  }
  return plain;
}

// Whether the ids in a set satisfy an expression: one of an OR, and all
// of an AND. An exception (WITH) only gives more.
function satisfies(
  node: LicenseExpression,
  has: (id: string) => boolean,
): boolean {
  if ("id" in node) return has(node.id);
  return node.op === "OR"
    ? satisfies(node.left, has) || satisfies(node.right, has)
    : satisfies(node.left, has) && satisfies(node.right, has);
}

// Every license id in an expression, once each.
export function licenseIds(expression: string): string[] {
  const ids = new Set<string>();
  const walk = (node: LicenseExpression) => {
    if ("id" in node) {
      ids.add(node.id);
    } else {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(parseLicense(expression));
  return [...ids];
}

// Whether a GPLv3 program can ship work under this expression.
export function isGpl3Compatible(
  expression: string,
  allowed: ReadonlySet<string> = GPL3_COMPATIBLE,
): boolean {
  try {
    return satisfies(parseLicense(expression), (id) =>
      allowed.has(spdxId(id, allowed)),
    );
  } catch {
    return false;
  }
}

const nameOf = (component: Component) =>
  [component.name, component.version].filter(Boolean).join(" ");

// Why the build can't ship these, if it can't: each one with no license,
// one off the list, or no license text.
export function licenseProblems(
  components: Component[],
  allowed: ReadonlySet<string> = GPL3_COMPATIBLE,
): string[] {
  const problems: string[] = [];
  for (const component of components) {
    const name = nameOf(component);
    if (!component.license) {
      problems.push(`${name} has no license`);
    } else if (!isGpl3Compatible(component.license, allowed)) {
      problems.push(
        `${name} is under ${component.license}, which isn't on GPL3_COMPATIBLE`,
      );
    } else if (component.texts.length === 0) {
      problems.push(
        `${name} ships no license text, and scripts/licenses hasn't the texts for ${component.license}`,
      );
    }
  }
  return problems;
}

// The npm package a bundled module is from: the folder under the last
// node_modules in its path. Null for the app's own code and for the
// bundler's own modules, whose ids start with \0.
export function packageDirOf(id: string): string | null {
  if (id.startsWith("\0")) return null;
  const parts = id.split("?")[0].replace(/\\/g, "/").split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const length = parts[at + 1]?.startsWith("@") ? 2 : 1;
  // The module is a file in it, so the path goes on past it.
  if (parts.length <= at + length + 1) return null;
  return parts.slice(0, at + length + 1).join("/");
}

// A package.json's license: an SPDX expression, or the old forms, an
// object or a list of them. Null if it has none.
export function npmLicense(pkg: {
  license?: unknown;
  licenses?: unknown;
}): string | null {
  const type = (value: unknown) =>
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "type" in value
        ? String(value.type)
        : null;
  if (pkg.license) return type(pkg.license);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map(type);
    if (types.every(Boolean)) return types.join(" OR ");
  }
  return null;
}

// Where a package's source is: its repository, as a web address, or its
// homepage.
export function npmUrl(pkg: {
  name: string;
  repository?: unknown;
  homepage?: unknown;
}): string {
  const repository =
    typeof pkg.repository === "string"
      ? pkg.repository
      : typeof pkg.repository === "object" &&
          pkg.repository !== null &&
          "url" in pkg.repository
        ? String(pkg.repository.url)
        : null;
  if (repository) {
    const shorthand = repository.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
    if (shorthand) return `https://github.com/${shorthand[1]}`;
    return repository
      .replace(/^git\+/, "")
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/^(git|ssh):\/\/(git@)?/, "https://")
      .replace(/\.git$/, "");
  }
  if (typeof pkg.homepage === "string") return pkg.homepage;
  return `https://www.npmjs.com/package/${pkg.name}`;
}

// An author's name, without the email or the web address.
function nameOfAuthor(author: unknown): string | null {
  const name =
    typeof author === "string"
      ? author
      : typeof author === "object" && author !== null && "name" in author
        ? String(author.name)
        : null;
  return name?.replace(/\s*[<(].*$/, "").trim() || null;
}

// LICENSE, LICENSE-MIT, LICENSE.md, LICENCE.txt, COPYING, NOTICE and the
// like.
const LICENSE_FILE_NAME =
  /^(licen[cs]e|copying|copyright|notice|unlicense)([-_.][\w.-]*)?$/i;

// A byte order mark, which some license files start with.
const BOM = 0xfeff;

// A text as written to the notices: no byte order mark, Unix line ends, no
// space at the ends of lines, no blank lines at either end.
export function cleanText(text: string): string {
  return (text.charCodeAt(0) === BOM ? text.slice(1) : text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// The license files in a package's or a crate's folder.
export function licenseFiles(dir: string): LicenseText[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => ({
      name,
      text: cleanText(fs.readFileSync(path.join(dir, name), "utf8")),
    }))
    .filter((file) => file.text);
}

// The copyright line in a package's README, for one that ships no license
// file: the first line that starts with "Copyright" and has a year.
export function readmeCopyright(dir: string): string | null {
  const readme = fs
    .readdirSync(dir)
    .find((name) => /^readme(\.(md|markdown|txt))?$/i.test(name));
  if (!readme) return null;
  const line = fs
    .readFileSync(path.join(dir, readme), "utf8")
    .split(/\r?\n/)
    .find((text) => /^\s*copyright\b.*\b(19|20)\d\d\b/i.test(text));
  return (
    line
      ?.trim()
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&") ?? null
  );
}

// scripts/licenses' texts for an expression's licenses, for a package that
// ships none, with copyright (the line, by license id) in place of their
// "Copyright (c) <copyright holders>". All of them, or none if they can't
// cover the expression: one of an OR, all of an AND. A GPL's text is the
// same for "-only" and "-or-later".
export function standardTexts(
  licensesDir: string,
  expression: string,
  copyright: (id: string) => string,
): LicenseText[] {
  let parsed: LicenseExpression;
  try {
    parsed = parseLicense(expression);
  } catch {
    return [];
  }
  const texts = new Map<string, LicenseText>();
  for (const id of licenseIds(expression).map((id) => spdxId(id))) {
    const base = id.replace(/-(only|or-later)$/, "");
    const file = path.join(licensesDir, `${base}.txt`);
    if (!/^[\w.-]+$/.test(base) || !fs.existsSync(file)) continue;
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/^Copyright \(c\) <copyright holders>$/m, () => copyright(id));
    texts.set(id, { name: id, text: cleanText(text) });
  }
  return satisfies(parsed, (id) => texts.has(spdxId(id)))
    ? [...texts.values()]
    : [];
}

// Copyright lines for packages that ship no license file and whose README
// doesn't say, by package and license id.
const COPYRIGHTS: Record<string, Record<string, string>> = {
  // As its wire/varint.js has it, from protobuf's JavaScript.
  "@bufbuild/protobuf": {
    "BSD-3-Clause": "Copyright 2008 Google Inc.  All rights reserved.",
  },
};

// An npm package, from its folder: its license files, or else
// scripts/licenses' texts for its license, with the copyright from its
// README or its author.
export function npmComponent(dir: string, licensesDir: string): Component {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  );
  const license = npmLicense(pkg) ?? "";
  const files = licenseFiles(dir);
  const copyright =
    readmeCopyright(dir) ??
    `Copyright (c) ${nameOfAuthor(pkg.author) ?? `the ${pkg.name} authors`}`;
  return {
    name: pkg.name,
    version: pkg.version,
    license,
    url: npmUrl(pkg),
    texts:
      files.length > 0
        ? files
        : standardTexts(
            licensesDir,
            license,
            (id) => COPYRIGHTS[pkg.name]?.[id] ?? copyright,
          ),
  };
}

// The folder of an installed package, looked for as Node would from dir.
function findPackage(dir: string, name: string): string | null {
  for (let at = dir; ; at = path.dirname(at)) {
    const candidate = path.join(at, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(at) === at) return null;
  }
}

// What a package's own build carries of others' code, which the bundler
// can't see, by the package: the others' names, read from node_modules, or
// for those not installed, what their licenses say.
type Embedded =
  string | { name: string; license: string; copyright: string; url: string };
const EMBEDDED: Record<string, Embedded[]> = {
  // Its browser build, the display's (see the alias in
  // electron.vite.config.ts), made with browserify: async's own build has
  // parts of lodash in it, and browserify adds its path and process.
  kuromoji: [
    "async",
    "lodash",
    "doublearray",
    "zlibjs",
    {
      name: "path-browserify",
      license: "MIT",
      copyright: "Copyright Joyent, Inc. and other Node contributors.",
      url: "https://github.com/browserify/path-browserify",
    },
    {
      name: "process",
      license: "MIT",
      copyright: "Copyright (c) 2013 Roman Shtylman <shtylman@gmail.com>",
      url: "https://github.com/defunctzombie/node-process",
    },
  ],
  "hls.js": [
    {
      name: "eventemitter3",
      license: "MIT",
      copyright: "Copyright (c) 2014 Arnout Kazemier",
      url: "https://github.com/primus/eventemitter3",
    },
    {
      name: "url-toolkit",
      license: "Apache-2.0",
      copyright: "",
      url: "https://github.com/tjenkinson/url-toolkit",
    },
  ],
};

// What one npm package's build carries (EMBEDDED), each with a note that
// it's in there.
export function embeddedComponents(
  dir: string,
  licensesDir: string,
): Component[] {
  const host = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  );
  const note = `In ${host.name}'s own build.`;
  return (EMBEDDED[host.name] ?? []).map((embedded) => {
    if (typeof embedded === "string") {
      const found = findPackage(dir, embedded);
      if (!found) {
        throw new Error(
          `${host.name} carries ${embedded}, which isn't installed`,
        );
      }
      return { ...npmComponent(found, licensesDir), notes: [note] };
    }
    const version =
      host.devDependencies?.[embedded.name] ??
      host.dependencies?.[embedded.name];
    return {
      name: embedded.name,
      version: version?.replace(/^[\^~]/, ""),
      license: embedded.license,
      url: embedded.url,
      notes: [note],
      texts: standardTexts(
        licensesDir,
        embedded.license,
        () => embedded.copyright,
      ),
    };
  });
}

// The modules the bundler adds of its own (ids that start with \0): the
// package each is from, as installed, or as given here. Null for one the
// notices don't know: the build stops, so someone looks.
export function bundlerComponent(
  id: string,
  root: string,
  licensesDir: string,
): Component | null {
  const installed = id.match(/^\0(vite|rolldown)\//);
  if (installed) {
    return npmComponent(
      path.join(root, "node_modules", installed[1]),
      licensesDir,
    );
  }
  // Helpers for the phones' older browsers, which rolldown carries.
  const oxc = id.match(/^\0@oxc-project\+runtime@([\w.-]+)\//);
  if (oxc) {
    return {
      name: "@oxc-project/runtime",
      version: oxc[1],
      license: "MIT",
      url: "https://github.com/oxc-project/oxc",
      notes: ["In the pages' code, put there by rolldown."],
      texts: standardTexts(
        licensesDir,
        "MIT",
        () =>
          "Copyright (c) 2024-present VoidZero Inc. & Contributors\nCopyright (c) 2023 Boshen",
      ),
    };
  }
  return null;
}

// The parts of `cargo metadata --format-version 1` read here.
export interface CargoMetadata {
  packages: {
    id: string;
    name: string;
    version: string;
    license: string | null;
    license_file: string | null;
    repository: string | null;
    homepage: string | null;
    authors: string[];
    manifest_path: string;
  }[];
  workspace_members: string[];
  resolve: {
    nodes: {
      id: string;
      deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
    }[];
  };
}

// The cargo metadata arguments for the native module `yarn build-*` builds:
// the target in CARGO_ARGS (--target), or this computer's, and the features
// asked for there.
export function cargoMetadataArgs(
  cargoArgs: string,
  host: string,
): { args: string[]; target: string } {
  const words = cargoArgs.split(/\s+/).filter(Boolean);
  let target = host;
  const features: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const [flag, inline] = words[i].split(/=(.*)/s, 2);
    const value = () => (inline !== undefined ? inline : words[++i]);
    if (flag === "--target") {
      target = value() ?? target;
    } else if (flag === "--features" || flag === "-F") {
      features.push("--features", value() ?? "");
    } else if (flag === "--no-default-features" || flag === "--all-features") {
      features.push(flag);
    }
  }
  return {
    args: [
      "metadata",
      "--format-version",
      "1",
      "--manifest-path",
      path.join("native", "Cargo.toml"),
      "--locked",
      "--filter-platform",
      target,
      ...features,
    ],
    target,
  };
}

// The crates in the native module: those the karafriends crate depends on,
// and theirs, for the platform the metadata was filtered for. Build and dev
// dependencies aren't in it; proc macros are listed, as the normal
// dependencies they are. The workspace's own crates are karafriends'.
export function crateComponents(
  metadata: CargoMetadata,
  licensesDir: string,
  rootCrate = "karafriends",
): Component[] {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const workspace = new Set(metadata.workspace_members);
  const root = metadata.packages.find(
    (pkg) => pkg.name === rootCrate && workspace.has(pkg.id),
  );
  if (!root) throw new Error(`No ${rootCrate} crate in the cargo metadata`);
  const linked = new Set<string>();
  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (linked.has(id)) continue;
    linked.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...linked]
    .filter((id) => !workspace.has(id))
    .map((id) => {
      const pkg = packages.get(id)!;
      const dir = path.dirname(pkg.manifest_path);
      const texts = licenseFiles(dir);
      // A license file elsewhere in the crate.
      if (pkg.license_file) {
        const name = pkg.license_file.replace(/\\/g, "/");
        if (!texts.some((text) => text.name === name)) {
          const text = cleanText(
            fs.readFileSync(path.join(dir, pkg.license_file), "utf8"),
          );
          texts.push({ name, text });
        }
      }
      const authors = pkg.authors.map(nameOfAuthor).filter(Boolean).join(", ");
      const license = pkg.license ?? "";
      return {
        name: pkg.name,
        version: pkg.version,
        license,
        url:
          pkg.repository ??
          pkg.homepage ??
          `https://crates.io/crates/${pkg.name}`,
        texts:
          texts.length > 0
            ? texts
            : standardTexts(
                licensesDir,
                license,
                () => `Copyright (c) ${authors || `the ${pkg.name} authors`}`,
              ),
      };
    });
}

// The remote's icons (src/remocon/icons.tsx), by the prefix of their names:
// where each set is from.
function iconSets(
  names: string[],
  licensesDir: string,
): Record<string, Component> {
  const listed = (prefix: string) =>
    `${names.filter((name) => name.startsWith(prefix)).join(", ")}, in the phone remote (src/remocon/icons.tsx), copied from react-icons.`;
  const mit = (copyright: string) =>
    standardTexts(licensesDir, "MIT", () => copyright);
  return {
    Bi: {
      name: "Boxicons",
      license: "MIT",
      url: "https://github.com/atisawd/boxicons",
      notes: [listed("Bi")],
      texts: mit("Copyright (c) 2015-2021 Aniket Suvarna"),
    },
    Bs: {
      name: "Bootstrap Icons",
      license: "MIT",
      url: "https://github.com/twbs/icons",
      notes: [listed("Bs")],
      texts: mit("Copyright (c) 2019-2024 The Bootstrap Authors"),
    },
    // The attribution Font Awesome asks for, as its own files carry it.
    Fa: {
      name: "Font Awesome Free 5",
      license: "CC-BY-4.0",
      url: "https://fontawesome.com",
      notes: [
        listed("Fa"),
        "Font Awesome Free by @fontawesome - https://fontawesome.com, by Fonticons, Inc.",
        "License - https://fontawesome.com/license/free (Icons: CC BY 4.0)",
        "Changed: drawn as inline SVG, some with a margin added to their viewBox.",
      ],
      texts: [
        {
          name: "CC BY 4.0",
          text: [
            "Creative Commons Attribution 4.0 International (CC BY 4.0)",
            "https://creativecommons.org/licenses/by/4.0/",
            "",
            "Its full text: https://creativecommons.org/licenses/by/4.0/legalcode",
          ].join("\n"),
        },
      ],
    },
    Md: {
      name: "Material Design icons",
      license: "Apache-2.0",
      url: "https://github.com/google/material-design-icons",
      notes: [listed("Md"), "By Google."],
      texts: standardTexts(licensesDir, "Apache-2.0", () => ""),
    },
  };
}

// What was copied into the repo and ships with the app: the lyrics fonts,
// if they went into the display's page, the remote's icons, if their file
// went into the remote's, and the kuromoji dictionary, which the pages'
// static/ folder brings along.
export function repoComponents(
  root: string,
  shipped: ReadonlySet<string>,
  licensesDir: string,
): Component[] {
  const has = (file: string) => shipped.has(path.join(root, file));
  const components: Component[] = [];
  const fonts = [
    "src/renderer/fonts/NotoSerifJP-SemiBold.otf",
    "src/renderer/fonts/NotoSerifKR-SemiBold.otf",
  ];
  if (fonts.some(has)) {
    components.push({
      name: "Noto Serif JP and Noto Serif KR, SemiBold",
      version: "1.001",
      license: "OFL-1.1",
      url: "https://github.com/notofonts/noto-cjk",
      // As the fonts' own name tables give them.
      notes: [
        "The display's lyrics fonts (src/renderer/fonts).",
        "Copyright © 2017 Adobe Systems Incorporated (http://www.adobe.com/).",
        "Noto is a trademark of Google Inc.",
      ],
      texts: standardTexts(licensesDir, "OFL-1.1", () => ""),
    });
  }
  const icons = "src/remocon/icons.tsx";
  if (has(icons)) {
    const source = fs.readFileSync(path.join(root, icons), "utf8");
    const names = [...source.matchAll(/^export const (\w+)/gm)].map(
      (match) => match[1],
    );
    const sets = iconSets(names, licensesDir);
    const prefixes = new Set(names.map((name) => name.slice(0, 2)));
    const unknown = [...prefixes].filter((prefix) => !(prefix in sets));
    if (unknown.length > 0) {
      throw new Error(
        `${icons} has icons from sets the notices don't know (${unknown.join(", ")}): add them to iconSets`,
      );
    }
    components.push(
      ...Object.entries(sets)
        .filter(([prefix]) => prefixes.has(prefix))
        .map(([, set]) => set),
    );
  }
  if (fs.existsSync(path.join(root, "static", "dict"))) {
    const notice = path.join(root, "node_modules", "kuromoji", "NOTICE.md");
    components.push({
      name: "mecab-ipadic",
      version: "2.7.0-20070801",
      license: "LicenseRef-IPADIC",
      url: "https://github.com/taku910/mecab",
      notes: [
        "The Japanese dictionary the display reads lyrics with (web/dict), as kuromoji.js builds it.",
      ],
      texts: [
        {
          name: "kuromoji's NOTICE.md",
          text: cleanText(fs.readFileSync(notice, "utf8")),
        },
      ],
    });
  }
  return components;
}

// The Rust standard library, which every Rust program links.
export function rustStd(release: string, licensesDir: string): Component {
  return {
    name: "The Rust standard library",
    version: release,
    license: "MIT OR Apache-2.0",
    url: "https://github.com/rust-lang/rust",
    notes: [
      `The notices of the parts it takes from elsewhere: https://github.com/rust-lang/rust/blob/${release}/COPYRIGHT`,
    ],
    texts: standardTexts(
      licensesDir,
      "MIT OR Apache-2.0",
      () => "Copyright (c) The Rust Project Developers",
    ),
  };
}

// Steinberg's ASIO SDK, compiled into the native module on Windows with
// cpal's ASIO support (asio-sys), from buildResources/asio
// (scripts/getExternalResources.mjs).
export function asioSdk(root: string): Component {
  const asioDir = path.join(root, "buildResources", "asio");
  const sdk = fs.existsSync(asioDir)
    ? fs
        .readdirSync(asioDir)
        .map((name) => path.join(asioDir, name))
        .find((dir) => fs.existsSync(path.join(dir, "LICENSE.txt")))
    : undefined;
  if (!sdk) {
    throw new Error(
      `No LICENSE.txt in the ASIO SDK in ${asioDir}: run \`yarn get-external-resources\``,
    );
  }
  const changes = path.join(sdk, "changes.txt");
  const version = fs.existsSync(changes)
    ? fs.readFileSync(changes, "utf8").match(/Changes in ASIO ([\d.]+)/)?.[1]
    : undefined;
  return {
    name: "Steinberg ASIO SDK",
    version,
    license: "GPL-3.0-only",
    url: "https://www.steinberg.net/developers/",
    notes: [
      "In the native module, for ASIO devices; used under its GPLv3 option.",
      "Its source: https://www.steinberg.net/asiosdk",
      "ASIO is a registered trademark of Steinberg Media Technologies GmbH.",
    ],
    texts: [
      {
        name: "LICENSE.txt",
        text: cleanText(fs.readFileSync(path.join(sdk, "LICENSE.txt"), "utf8")),
      },
    ],
  };
}

// The 7za packager.js puts beside the app, from 7zip-bin: 7-Zip's on
// Windows, p7zip's (a port of 7-Zip) on macOS and Linux.
export function sevenZip(
  root: string,
  platform: string,
  licensesDir: string,
): Component {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(root, "node_modules", "7zip-bin", "package.json"),
      "utf8",
    ),
  );
  const what = `The archive extractor in the app's resources folder, from the 7zip-bin ${pkg.version} package. It unpacks the tools the app downloads.`;
  const texts = standardTexts(licensesDir, "LGPL-2.1-or-later", () => "");
  if (platform === "win32") {
    return {
      name: "7-Zip (7za.exe)",
      license: "LGPL-2.1-or-later",
      url: "https://www.7-zip.org",
      notes: [
        what,
        "7-Zip Copyright (C) 1999-2021 Igor Pavlov.",
        "Its source: https://www.7-zip.org/download.html",
      ],
      texts,
    };
  }
  return {
    name: "p7zip (7za)",
    license: "LGPL-2.1-or-later",
    url: "https://sourceforge.net/projects/p7zip/",
    notes: [
      what,
      "p7zip, a port of 7-Zip by myspace. 7-Zip Copyright (C) Igor Pavlov.",
      "Its source: https://sourceforge.net/projects/p7zip/ (16.02), and https://github.com/p7zip-project/p7zip (17.x, the Intel Mac build).",
    ],
    texts,
  };
}

// The platform a Rust target is for, as Node names it.
export function targetPlatform(target: string): NodeJS.Platform {
  if (target.includes("-windows")) return "win32";
  if (target.includes("-apple-darwin")) return "darwin";
  if (target.includes("-linux")) return "linux";
  return process.platform;
}

// Wraps a paragraph to 78 columns, each line after indent.
function wrap(text: string, indent = ""): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > 78) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

export interface NoticeSection {
  title: string;
  intro: string;
  components: Component[];
}

// The notices file: an introduction, every component under its section
// with the numbers of its license texts, a few notes, and each license
// text once, at the end, with what is under it.
export function renderNotices(notices: {
  version: string;
  target: string;
  sections: NoticeSection[];
  notes: { title: string; paragraphs: string[] }[];
}): string {
  // The license texts by their words, whatever the line breaks.
  const texts: { text: LicenseText; users: Set<string> }[] = [];
  const numbers = new Map<string, number>();
  const numberOf = (text: LicenseText, user: string) => {
    const key = text.text.replace(/\s+/g, " ").trim();
    let number = numbers.get(key);
    if (number === undefined) {
      number = texts.push({ text, users: new Set() });
      numbers.set(key, number);
    }
    texts[number - 1].users.add(user);
    return number;
  };

  const title = (underline: string, text: string) =>
    `${text}\n${underline.repeat(Math.min(text.length, 78))}`;
  const out: string[] = [
    title("=", `karafriends ${notices.version}: third-party notices`),
    wrap(
      `karafriends is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3, in ${LICENSE_FILE} beside this file. Its source: ${SOURCE_URL}`,
    ),
    wrap(
      `It is built with the work of others, listed here with their licenses. The license texts are at the end, numbered; each entry gives the numbers of its own. This build is for ${notices.target}.`,
    ),
  ];
  notices.sections.forEach((section, index) => {
    out.push(title("-", `${index + 1}. ${section.title}`), wrap(section.intro));
    for (const component of section.components) {
      const name = nameOf(component);
      const lines = [name, `  License: ${component.license}`];
      if (component.url) lines.push(`  ${component.url}`);
      for (const note of component.notes ?? []) lines.push(wrap(note, "  "));
      const refs = component.texts.map(
        (text) => `[${numberOf(text, name)}] ${text.name}`,
      );
      lines.push(wrap(`License text: ${refs.join(", ")}`, "  "));
      out.push(lines.join("\n"));
    }
  });
  notices.notes.forEach((note, index) => {
    out.push(
      title("-", `${notices.sections.length + index + 1}. ${note.title}`),
      ...note.paragraphs.map((paragraph) => wrap(paragraph)),
    );
  });
  out.push(title("=", "License texts"));
  texts.forEach(({ text, users }, index) => {
    out.push(
      title("-", `[${index + 1}] ${text.name}`),
      wrap(`For: ${[...users].join(", ")}`),
      text.text,
    );
  });
  return `${out.join("\n\n")}\n`;
}

// What the bundler put in one output: each module with code in it, and
// each file an asset was made from, by absolute path (or \0 id). Assets
// name theirs from root, the build's.
type Bundle = Record<
  string,
  | { type: "chunk"; modules: Record<string, { renderedLength: number }> }
  | { type: "asset"; originalFileNames?: string[] }
>;

export function shippedFiles(bundle: Bundle, root: string): string[] {
  const files: string[] = [];
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk") {
      for (const [id, info] of Object.entries(output.modules)) {
        if (info.renderedLength > 0) files.push(id);
      }
    } else {
      files.push(...(output.originalFileNames ?? []));
    }
  }
  return files.map((file) =>
    file.startsWith("\0") ? file : path.resolve(root, file.split("?")[0]),
  );
}

type BundleName = "main" | "preload" | "renderer";

// The Vite plugins that write the notices: one for each of electron-vite's
// three builds, and one for the workers the renderer's build makes. Each
// keeps what went into its output; once the three are written, the
// notices are, beside them in outDir. Builds only: `yarn dev` writes none.
export function thirdPartyNotices(options: { outDir: string; root?: string }) {
  const root = path.resolve(options.root ?? ".");
  const licensesDir = path.join(root, "scripts", "licenses");
  const shipped = new Set<string>();
  const written = new Set<BundleName>();

  const keep = (bundle: unknown, buildRoot: string) => {
    for (const file of shippedFiles(bundle as Bundle, buildRoot)) {
      shipped.add(file);
    }
  };

  const write = (log: (message: string) => void) => {
    // npm packages, once each by name and version, with what their builds
    // carry, and what the bundler adds.
    const npm = new Map<string, Component>();
    const add = (component: Component) => npm.set(nameOf(component), component);
    const dirs = new Set<string>();
    const unknown: string[] = [];
    for (const file of shipped) {
      if (file.startsWith("\0")) {
        const bundler = bundlerComponent(file, root, licensesDir);
        if (bundler) add(bundler);
        else unknown.push(file.slice(1));
      }
      const dir = packageDirOf(file);
      if (dir) dirs.add(path.resolve(dir));
    }
    if (unknown.length > 0) {
      throw new Error(
        `The bundler put modules of its own in the app that the notices don't know (add them to bundlerComponent):\n${unknown.map((id) => `  - ${id}`).join("\n")}`,
      );
    }
    for (const dir of dirs) {
      add(npmComponent(dir, licensesDir));
      embeddedComponents(dir, licensesDir).forEach(add);
    }

    const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = rustc.match(/^host: (.+)$/m)?.[1].trim() ?? "";
    const release = rustc.match(/^release: (.+)$/m)?.[1].trim() ?? "";
    const cargo = cargoMetadataArgs(process.env.CARGO_ARGS ?? "", host);
    const metadata: CargoMetadata = JSON.parse(
      execFileSync("cargo", cargo.args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
    const crates = crateComponents(metadata, licensesDir);
    const platform = targetPlatform(cargo.target);

    const byName = (a: Component, b: Component) =>
      a.name.localeCompare(b.name, "en") ||
      (a.version ?? "").localeCompare(b.version ?? "", "en", {
        numeric: true,
      });
    const sections: NoticeSection[] = [
      {
        title: "npm packages",
        intro:
          "In the app's code: the main process, the display's preload, and the display's and the phone remote's pages.",
        components: [...npm.values()].sort(byName),
      },
      {
        title: "The native module",
        intro:
          "The Rust crates linked into the native module (native/index.node, the mics and their sound), the Rust standard library, and on Windows the ASIO SDK.",
        components: [
          ...crates.sort(byName),
          rustStd(release, licensesDir),
          ...(crates.some((crate) => crate.name === "asio-sys")
            ? [asioSdk(root)]
            : []),
        ],
      },
      {
        title: "Fonts, icons and data",
        intro: "Copied into karafriends' source, and shipped with the app.",
        components: repoComponents(root, shipped, licensesDir),
      },
      {
        title: "Beside the app",
        intro: "A program shipped in the app's folder, which the app runs.",
        components: [sevenZip(root, platform, licensesDir)],
      },
    ];

    const problems = licenseProblems(
      sections.flatMap((section) => section.components),
    );
    if (problems.length > 0) {
      throw new Error(
        `The app can't ship these under the GPLv3 as they are:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
      );
    }

    const readJson = (...parts: string[]) =>
      JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));
    const electron = readJson("node_modules", "electron", "package.json");
    const text = renderNotices({
      version: readJson("package.json").version,
      target: cargo.target,
      sections,
      notes: [
        {
          title: "Electron",
          paragraphs: [
            `karafriends runs in Electron ${electron.version} (MIT), which includes Chromium and Node.js. Their notices come with the app, in the folder it is in: Electron's license in LICENSE, and Chromium's and its parts' in LICENSES.chromium.html.`,
          ],
        },
        {
          title: "Not shipped",
          paragraphs: [
            "karafriends doesn't ship the ffmpeg and yt-dlp programs it downloads songs with. When first needed, it downloads them from their own projects' builds, under their own licenses: yt-dlp from https://github.com/yt-dlp/yt-dlp, and ffmpeg (https://ffmpeg.org) from gyan.dev on Windows, ffmpeg.martin-riedl.de on macOS, and BtbN/FFmpeg-Builds on Linux. (The ffmpeg library that comes with Electron is Chromium's, in its notices.)",
          ],
        },
      ],
    });
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(path.join(options.outDir, NOTICES_FILE), text);
    fs.copyFileSync(
      path.join(root, "LICENSE"),
      path.join(options.outDir, LICENSE_FILE),
    );
    log(
      `${NOTICES_FILE}: ${npm.size} npm packages, ${crates.length} crates, for ${cargo.target}`,
    );
  };

  const plugin = (name: BundleName): Plugin => {
    let buildRoot = root;
    let log = (message: string) => console.log(message);
    return {
      name: "karafriends:third-party-notices",
      apply: "build",
      configResolved(config) {
        buildRoot = config.root;
        log = (message) => config.logger.info(message);
      },
      generateBundle(_options, bundle) {
        keep(bundle, buildRoot);
      },
      writeBundle() {
        written.add(name);
        if (written.size === 3) write(log);
      },
    };
  };

  // The renderer's workers: what goes into them ships with its pages.
  const worker = (): Plugin => {
    let buildRoot = root;
    return {
      name: "karafriends:third-party-notices-worker",
      apply: "build",
      configResolved(config) {
        buildRoot = config.root;
      },
      generateBundle(_options, bundle) {
        keep(bundle, buildRoot);
      },
    };
  };

  return { plugin, worker };
}
