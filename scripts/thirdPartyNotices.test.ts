import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  bundlerComponent,
  type CargoMetadata,
  cargoMetadataArgs,
  type Component,
  crateComponents,
  isGpl3Compatible,
  licenseProblems,
  npmComponent,
  npmLicense,
  npmUrl,
  packageDirOf,
  renderNotices,
  shippedFiles,
  standardTexts,
  targetPlatform,
} from "./thirdPartyNotices";

const LICENSES = path.join(__dirname, "licenses");
const ROOT = path.join(__dirname, "..");

test("licenses a GPLv3 program can ship pass, others don't", () => {
  for (const ok of [
    "MIT",
    "MIT OR Apache-2.0",
    "(MIT OR Apache-2.0) AND Unicode-3.0",
    "Zlib OR MIT OR Apache-2.0",
    "(Apache-2.0 AND BSD-3-Clause)",
    // Cargo's old way of saying either.
    "MIT/Apache-2.0",
    // SPDX ids match whatever their case.
    "zlib",
    "mit or apache-2.0",
    "LGPL-2.1+",
    "Apache-2.0 WITH LLVM-exception",
    // Either will do.
    "GPL-2.0-only OR MIT",
    "MPL-2.0",
    "OFL-1.1",
    "CC-BY-4.0",
  ]) {
    assert.ok(isGpl3Compatible(ok), ok);
  }
  for (const refused of [
    "",
    "GPL-2.0-only",
    "MIT AND GPL-2.0-only",
    "SSPL-1.0",
    "CC-BY-NC-4.0",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.md",
    // Not SPDX.
    "Apache 2.0",
    "MIT OR",
    "(MIT",
    "MIT WITH",
  ]) {
    assert.equal(isGpl3Compatible(refused), false, refused);
  }
});

test("the build is refused a package with no license, one off the list, or no license text", () => {
  const text = [{ name: "LICENSE", text: "MIT License" }];
  const components: Component[] = [
    { name: "fine", version: "1.0.0", license: "MIT", texts: text },
    { name: "unlicensed", version: "1.0.0", license: "", texts: text },
    {
      name: "copyleft",
      version: "2.0.0",
      license: "AGPL-3.0-only",
      texts: text,
    },
    { name: "textless", version: "3.0.0", license: "ISC", texts: [] },
  ];
  assert.deepEqual(licenseProblems(components), [
    "unlicensed 1.0.0 has no license",
    "copyleft 2.0.0 is under AGPL-3.0-only, which isn't on GPL3_COMPATIBLE",
    "textless 3.0.0 ships no license text, and scripts/licenses hasn't the texts for ISC",
  ]);
  // The list is the build's to give.
  assert.deepEqual(licenseProblems([components[0]], new Set(["Apache-2.0"])), [
    "fine 1.0.0 is under MIT, which isn't on GPL3_COMPATIBLE",
  ]);
});

test("a bundled module's package is the folder under its last node_modules", () => {
  assert.equal(
    packageDirOf("C:/app/node_modules/react/cjs/react.production.js"),
    "C:/app/node_modules/react",
  );
  assert.equal(
    packageDirOf(
      "C:\\app\\node_modules\\@tanstack\\query-core\\build\\modern\\query.js",
    ),
    "C:/app/node_modules/@tanstack/query-core",
  );
  // A copy of its own, under another package.
  assert.equal(
    packageDirOf(
      "/app/node_modules/compression/node_modules/negotiator/index.js",
    ),
    "/app/node_modules/compression/node_modules/negotiator",
  );
  assert.equal(
    packageDirOf(
      "/app/node_modules/kuromoji/build/kuromoji.js?commonjs-es-import",
    ),
    "/app/node_modules/kuromoji",
  );
  // The app's own code, and the bundler's.
  assert.equal(packageDirOf("/app/src/renderer/App.tsx"), null);
  assert.equal(packageDirOf("\0rolldown/runtime.js"), null);
});

test("what went into an output: modules with code in them, and the files of its assets", () => {
  const root = path.resolve("app", "src");
  const files = shippedFiles(
    {
      "index.js": {
        type: "chunk",
        modules: {
          [path.resolve("app/node_modules/react/index.js")]: {
            renderedLength: 120,
          },
          // Shaken out to nothing.
          [path.resolve("app/node_modules/unused/index.js")]: {
            renderedLength: 0,
          },
          "\0rolldown/runtime.js": { renderedLength: 300 },
        },
      },
      // Assets name their files from the build's root.
      "assets/font.otf": {
        type: "asset",
        originalFileNames: ["renderer/fonts/font.otf"],
      },
    },
    root,
  );
  assert.deepEqual(files, [
    path.resolve("app/node_modules/react/index.js"),
    "\0rolldown/runtime.js",
    path.join(root, "renderer", "fonts", "font.otf"),
  ]);
});

test("a package.json's license, in its old forms too", () => {
  assert.equal(npmLicense({ license: "MIT" }), "MIT");
  assert.equal(npmLicense({ license: { type: "ISC" } }), "ISC");
  assert.equal(
    npmLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "MIT OR Apache-2.0",
  );
  assert.equal(npmLicense({}), null);
});

test("a package's source, as a web address", () => {
  assert.equal(
    npmUrl({
      name: "a",
      repository: { url: "git+https://github.com/owner/a.git" },
    }),
    "https://github.com/owner/a",
  );
  assert.equal(
    npmUrl({ name: "a", repository: "owner/a" }),
    "https://github.com/owner/a",
  );
  assert.equal(
    npmUrl({ name: "a", repository: "git@github.com:owner/a.git" }),
    "https://github.com/owner/a",
  );
  assert.equal(
    npmUrl({ name: "a", repository: { url: "git://github.com/owner/a" } }),
    "https://github.com/owner/a",
  );
  assert.equal(
    npmUrl({ name: "a", homepage: "https://a.example" }),
    "https://a.example",
  );
  assert.equal(npmUrl({ name: "a" }), "https://www.npmjs.com/package/a");
});

test("scripts/licenses' texts cover an expression, or there are none", () => {
  const copyright = () => "Copyright (c) 2020 Someone";
  const mit = standardTexts(LICENSES, "MIT", copyright);
  assert.equal(mit.length, 1);
  assert.match(mit[0].text, /^MIT License\n\nCopyright \(c\) 2020 Someone\n/);
  assert.deepEqual(
    standardTexts(LICENSES, "MIT OR Apache-2.0", copyright).map((t) => t.name),
    ["MIT", "Apache-2.0"],
  );
  // One of an OR will do; an AND needs all of them.
  assert.deepEqual(
    standardTexts(LICENSES, "MIT OR Nonexistent-1.0", copyright).map(
      (t) => t.name,
    ),
    ["MIT"],
  );
  assert.deepEqual(
    standardTexts(LICENSES, "MIT AND Nonexistent-1.0", copyright),
    [],
  );
  // A GPL's text is the same, "-only" or "-or-later".
  assert.deepEqual(
    standardTexts(LICENSES, "LGPL-2.1-or-later", copyright).map((t) => t.name),
    ["LGPL-2.1-or-later"],
  );
  assert.deepEqual(
    standardTexts(LICENSES, "not an expression (", copyright),
    [],
  );
});

test("Rust targets and CARGO_ARGS: the platform the notices are for", () => {
  const manifest = path.join("native", "Cargo.toml");
  const base = [
    "metadata",
    "--format-version",
    "1",
    "--manifest-path",
    manifest,
    "--locked",
    "--filter-platform",
  ];
  assert.deepEqual(cargoMetadataArgs("", "x86_64-pc-windows-msvc"), {
    args: [...base, "x86_64-pc-windows-msvc"],
    target: "x86_64-pc-windows-msvc",
  });
  assert.deepEqual(
    cargoMetadataArgs(
      "--target x86_64-apple-darwin --no-default-features",
      "aarch64-apple-darwin",
    ),
    {
      args: [...base, "x86_64-apple-darwin", "--no-default-features"],
      target: "x86_64-apple-darwin",
    },
  );
  assert.deepEqual(
    cargoMetadataArgs("--target=aarch64-unknown-linux-gnu -F asio", "host"),
    {
      args: [...base, "aarch64-unknown-linux-gnu", "--features", "asio"],
      target: "aarch64-unknown-linux-gnu",
    },
  );
  assert.equal(targetPlatform("x86_64-pc-windows-msvc"), "win32");
  assert.equal(targetPlatform("x86_64-apple-darwin"), "darwin");
  assert.equal(targetPlatform("x86_64-unknown-linux-gnu"), "linux");
});

describe("packages and crates on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-notices-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writePackage = (name: string, files: Record<string, string>) => {
    const pkg = path.join(dir, name);
    fs.mkdirSync(pkg, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(pkg, file), text);
    }
    return pkg;
  };

  test("an npm package's license files, or a standard text with its README's copyright", () => {
    const shipsOne = writePackage("ships-one", {
      "package.json": JSON.stringify({
        name: "ships-one",
        version: "1.2.3",
        license: "ISC",
        repository: "owner/ships-one",
      }),
      "LICENSE.md": "\uFEFFISC License\r\n\r\nCopyright (c) Owner  \r\n",
      "index.js": "",
    });
    assert.deepEqual(npmComponent(shipsOne, LICENSES), {
      name: "ships-one",
      version: "1.2.3",
      license: "ISC",
      url: "https://github.com/owner/ships-one",
      texts: [
        { name: "LICENSE.md", text: "ISC License\n\nCopyright (c) Owner" },
      ],
    });

    const shipsNone = writePackage("ships-none", {
      "package.json": JSON.stringify({
        name: "ships-none",
        version: "1.0.0",
        license: "MIT",
        author: "Someone <someone@example.com>",
      }),
      "README.md":
        "# ships-none\n\n## License\n\nCopyright (c) 2014 Someone &lt;someone@example.com&gt;\n",
    });
    const [text] = npmComponent(shipsNone, LICENSES).texts;
    assert.equal(text.name, "MIT");
    assert.match(
      text.text,
      /\nCopyright \(c\) 2014 Someone <someone@example\.com>\n/,
    );

    // No README to go by: its author.
    fs.rmSync(path.join(shipsNone, "README.md"));
    assert.match(
      npmComponent(shipsNone, LICENSES).texts[0].text,
      /\nCopyright \(c\) Someone\n/,
    );
  });

  test("the crates linked in: normal dependencies of karafriends, not build or dev ones, nor the workspace's own", () => {
    const crate = (name: string, files: Record<string, string> = {}) =>
      path.join(
        writePackage(name, { "Cargo.toml": "", ...files }),
        "Cargo.toml",
      );
    const pkg = (
      name: string,
      license: string | null,
      manifest: string,
      authors: string[] = [],
    ) => ({
      id: `${name} 1.0.0`,
      name,
      version: "1.0.0",
      license,
      license_file: null,
      repository: null,
      homepage: null,
      authors,
      manifest_path: manifest,
    });
    const normal = (name: string) => ({
      pkg: `${name} 1.0.0`,
      dep_kinds: [{ kind: null }],
    });
    const metadata: CargoMetadata = {
      packages: [
        pkg("karafriends", null, crate("karafriends")),
        pkg("karafriends-lib", null, crate("karafriends-lib")),
        pkg("cpal", "Apache-2.0", crate("cpal", { LICENSE: "Apache text" })),
        pkg("neon", "MIT/Apache-2.0", crate("neon"), [
          "Dave <dave@example.com>",
        ]),
        pkg("bindgen", "BSD-3-Clause", crate("bindgen", { LICENSE: "BSD" })),
        pkg("wavegen", "MIT", crate("wavegen", { LICENSE: "MIT" })),
      ],
      workspace_members: ["karafriends 1.0.0", "karafriends-lib 1.0.0"],
      resolve: {
        nodes: [
          {
            id: "karafriends 1.0.0",
            deps: [normal("karafriends-lib"), normal("neon")],
          },
          {
            id: "karafriends-lib 1.0.0",
            deps: [
              normal("cpal"),
              { pkg: "wavegen 1.0.0", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          {
            id: "cpal 1.0.0",
            deps: [{ pkg: "bindgen 1.0.0", dep_kinds: [{ kind: "build" }] }],
          },
          { id: "neon 1.0.0", deps: [] },
          { id: "bindgen 1.0.0", deps: [] },
          { id: "wavegen 1.0.0", deps: [] },
        ],
      },
    };
    const crates = crateComponents(metadata, LICENSES);
    assert.deepEqual(crates.map((c) => c.name).sort(), ["cpal", "neon"]);
    const cpal = crates.find((c) => c.name === "cpal")!;
    assert.deepEqual(cpal.texts, [{ name: "LICENSE", text: "Apache text" }]);
    assert.equal(cpal.url, "https://crates.io/crates/cpal");
    // Neon ships none: both standard texts, the MIT one with its authors.
    const neon = crates.find((c) => c.name === "neon")!;
    assert.deepEqual(
      neon.texts.map((t) => t.name),
      ["MIT", "Apache-2.0"],
    );
    assert.match(neon.texts[0].text, /\nCopyright \(c\) Dave\n/);
  });
});

test("the bundler's own modules: rolldown's runtime, as installed, and oxc's helpers", () => {
  const rolldown = bundlerComponent("\0rolldown/runtime.js", ROOT, LICENSES);
  assert.equal(rolldown?.name, "rolldown");
  assert.equal(rolldown?.license, "MIT");
  const oxc = bundlerComponent(
    "\0@oxc-project+runtime@0.155.0/helpers/esm/typeof.js",
    ROOT,
    LICENSES,
  );
  assert.equal(oxc?.name, "@oxc-project/runtime");
  assert.equal(oxc?.version, "0.155.0");
  assert.equal(oxc?.texts.length, 1);
  // One the notices don't know stops the build.
  assert.equal(
    bundlerComponent("\0some-plugin/helper.js", ROOT, LICENSES),
    null,
  );
});

test("the notices: each component with the numbers of its texts, each text once", () => {
  const mit = { name: "LICENSE", text: "MIT License\n\nCopyright (c) A" };
  const text = renderNotices({
    version: "0.2.0",
    target: "x86_64-pc-windows-msvc",
    sections: [
      {
        title: "npm packages",
        intro: "In the app's code.",
        components: [
          { name: "a", version: "1.0.0", license: "MIT", texts: [mit] },
          // The same words, wrapped differently.
          {
            name: "b",
            version: "2.0.0",
            license: "MIT",
            url: "https://b.example",
            notes: ["A note."],
            texts: [
              { name: "LICENSE.md", text: "MIT License\nCopyright (c) A" },
            ],
          },
          {
            name: "c",
            license: "ISC",
            texts: [{ name: "LICENSE", text: "ISC License" }],
          },
        ],
      },
    ],
    notes: [{ title: "Not shipped", paragraphs: ["ffmpeg and yt-dlp."] }],
  });
  assert.match(text, /^karafriends 0\.2\.0: third-party notices\n=+\n/);
  assert.match(text, /This build is for x86_64-pc-windows-msvc\./);
  assert.match(
    text,
    /\na 1\.0\.0\n {2}License: MIT\n {2}License text: \[1\] LICENSE\n/,
  );
  assert.match(
    text,
    /\nb 2\.0\.0\n {2}License: MIT\n {2}https:\/\/b\.example\n {2}A note\.\n {2}License text: \[1\] LICENSE\.md\n/,
  );
  assert.match(
    text,
    /\nc\n {2}License: ISC\n {2}License text: \[2\] LICENSE\n/,
  );
  assert.match(text, /\n2\. Not shipped\n-+\n\nffmpeg and yt-dlp\.\n/);
  assert.match(
    text,
    /\n\[1\] LICENSE\n-+\n\nFor: a 1\.0\.0, b 2\.0\.0\n\nMIT License\n\nCopyright \(c\) A\n/,
  );
  assert.match(text, /\n\[2\] LICENSE\n-+\n\nFor: c\n\nISC License\n$/);
  assert.equal(text.match(/MIT License/g)?.length, 1);
});
