// Runs on Node's test runner through tsx (yarn test:unit). karafriends' link
// to the Joysound account, against a local server that plays sound-cafe: its
// website's login and TV link page, and the TV API's linkCode and linkInfo.
// The link store is in memory; the shared link is the app's own
// (createCredentialProviders, with a real config store in a temp folder).
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  mock,
  test,
} from "node:test";

import { createConfigStore } from "../common/configStore";
import { createCredentialProviders, LoginWarning } from "./credentials";
import {
  createJoysoundLinker,
  linkStatusNote,
  type LinkStore,
  type StoredLink,
} from "./joysoundLink";

const EMAIL = "joy@example.com";
const PASSWORD = "joy-pw";
// The codes sound-cafe issues: SECRETCODE1, SECRETCODE2, ...
const CODE = "SECRETCODE";

let server: http.Server;
let base: string;
// What the server was asked, as "METHOD /path".
const asked: string[] = [];
// What the clients logged.
const logged: string[] = [];

// sound-cafe's state.
let site: {
  codes: Map<string, { valid: boolean; linked: boolean }>;
  password: string;
  membership: string;
  // Whether opening the link page links the code (as it did on 2026-10-29).
  linkPageLinks: boolean;
  // Whether signing in gives a session.
  loginSticks: boolean;
};

const html = (res: ServerResponse, text: string, headers = {}) => {
  res.writeHead(200, { "Content-Type": "text/html", ...headers });
  res.end(text);
};
const json = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

function serve(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url ?? "/", base);
  const form = new URLSearchParams(body);
  const signedIn = (req.headers.cookie ?? "").includes("JSESSIONID=signed-in");
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /login") {
    return html(res, '<meta name="_csrf" content="csrf-1" />', {
      "Set-Cookie": "XSRF-TOKEN=xsrf-1; Path=/",
    });
  }
  if (route === "POST /login/check") {
    if (req.headers["x-xsrf-token"] !== "csrf-1")
      return json(res, { result: 9 });
    const ok =
      form.get("mailAddress") === EMAIL &&
      form.get("password") === site.password;
    return json(res, { result: ok ? 0 : 1, message: "" });
  }
  if (route === "POST /login") {
    const cookie = site.loginSticks
      ? "JSESSIONID=signed-in"
      : "JSESSIONID=anon";
    res.writeHead(302, { Location: "/", "Set-Cookie": `${cookie}; Path=/` });
    return res.end();
  }
  if (route === "GET /") return html(res, "<html>home</html>");
  if (req.method === "GET" && url.pathname.startsWith("/mypage/tvlink/")) {
    if (!signedIn) {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    const code = site.codes.get(
      decodeURIComponent(url.pathname.slice("/mypage/tvlink/".length)),
    );
    if (code?.valid && site.linkPageLinks) code.linked = true;
    return html(res, "<html>テレビアプリとの連携が完了しました</html>");
  }
  if (route === "POST /api/v1/linkCode") {
    const linkCode = `${CODE}${site.codes.size + 1}`;
    site.codes.set(linkCode, { valid: true, linked: false });
    return json(res, { linkCode, expire: "2026-10-29 13:00:00" });
  }
  if (route === "POST /api/v1/linkInfo") {
    const { linkCode } = JSON.parse(body) as { linkCode: string };
    assert.equal(req.headers["x-linkcode"], linkCode);
    const code = site.codes.get(linkCode);
    return json(res, {
      isValid: Boolean(code?.valid),
      isLinked: Boolean(code?.valid && code.linked),
      membershipType: code?.valid && code.linked ? site.membership : null,
    });
  }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<html>not found</html>");
}

before(async () => {
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      asked.push(`${req.method} ${new URL(req.url ?? "/", base).pathname}`);
      serve(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  mock.restoreAll();
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  asked.length = 0;
  logged.length = 0;
  site = {
    codes: new Map(),
    password: PASSWORD,
    membership: "PAID",
    linkPageLinks: true,
    loginSticks: true,
  };
});

function memoryStore(initial: StoredLink | null = null) {
  const store: LinkStore & { value: StoredLink | null } = {
    value: initial,
    load: () => store.value,
    save: (link) => {
      store.value = link;
    },
  };
  return store;
}

const linkerWith = (store: LinkStore) =>
  createJoysoundLinker({ store, baseURL: base });

// What linking a new code asks, in order.
const NEW_LINK = [
  "POST /api/v1/linkCode",
  "GET /login",
  "POST /login/check",
  "POST /login",
  "GET /",
  "GET /mypage/tvlink/SECRETCODE1",
  "POST /api/v1/linkInfo",
];

// No secret in anything the clients logged, nor in err's message.
function assertNoSecrets(err?: unknown) {
  for (const text of [...logged, String((err as Error)?.message ?? "")]) {
    assert.ok(!text.includes(CODE), text);
    assert.ok(!text.includes(PASSWORD), text);
  }
}

describe("createJoysoundLinker's link", () => {
  test("links a new code with the saved login, and keeps it for the account", async () => {
    const store = memoryStore();
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.deepEqual(link, {
      linkCode: "SECRETCODE1",
      membershipType: "PAID",
    });
    assert.deepEqual(asked, NEW_LINK);
    assert.deepEqual(store.value, { account: EMAIL, linkCode: "SECRETCODE1" });
    assertNoSecrets();
  });

  test("after a restart, checks the kept link instead of linking again", async () => {
    const store = memoryStore();
    await linkerWith(store).link(EMAIL, PASSWORD);
    asked.length = 0;
    // A new linker on the same store: the app, restarted.
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.deepEqual(link, {
      linkCode: "SECRETCODE1",
      membershipType: "PAID",
    });
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);
  });

  test("finishes a link that failed halfway with the same code", async () => {
    const store = memoryStore();
    site.password = "changed";
    await assert.rejects(
      linkerWith(store).link(EMAIL, PASSWORD),
      /login rejected \(result 1\)/,
    );
    // Kept, though not linked yet.
    assert.deepEqual(store.value, { account: EMAIL, linkCode: "SECRETCODE1" });

    site.password = PASSWORD;
    asked.length = 0;
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.equal(link.linkCode, "SECRETCODE1");
    assert.ok(!asked.includes("POST /api/v1/linkCode"), asked.join(", "));
    assert.equal(site.codes.size, 1);
  });

  test("links a new code once the kept one has ended", async () => {
    const store = memoryStore();
    await linkerWith(store).link(EMAIL, PASSWORD);
    site.codes.get("SECRETCODE1")!.valid = false;
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.equal(link.linkCode, "SECRETCODE2");
    assert.deepEqual(store.value, { account: EMAIL, linkCode: "SECRETCODE2" });
  });

  test("fails, once, when opening the link page doesn't link the code", async () => {
    const store = memoryStore();
    site.linkPageLinks = false;
    const err = await linkerWith(store)
      .link(EMAIL, PASSWORD)
      .then(
        () => assert.fail("it linked"),
        (failure: unknown) => failure,
      );
    assert.match(String(err), /didn't link karafriends to the account/);
    assert.deepEqual(asked, NEW_LINK);
    // Tried again later, it authorizes the same code: no new one.
    asked.length = 0;
    await assert.rejects(linkerWith(store).link(EMAIL, PASSWORD));
    assert.ok(!asked.includes("POST /api/v1/linkCode"));
    assertNoSecrets(err);
  });

  test("fails when the website doesn't take the sign-in", async () => {
    site.loginSticks = false;
    const err = await linkerWith(memoryStore())
      .link(EMAIL, PASSWORD)
      .then(
        () => assert.fail("it linked"),
        (failure: unknown) => failure,
      );
    assert.match(String(err), /the sign-in didn't take/);
    assert.equal(site.codes.get("SECRETCODE1")?.linked, false);
    assertNoSecrets(err);
  });

  test("never uses a link made for another account", async () => {
    const store = memoryStore({ account: "other@example.com", linkCode: "X" });
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.equal(link.linkCode, "SECRETCODE1");
    assert.deepEqual(asked, NEW_LINK);
  });

  test("treats the email's case and spaces as the same account", async () => {
    const store = memoryStore();
    await linkerWith(store).link(EMAIL, PASSWORD);
    asked.length = 0;
    await linkerWith(store).link(" Joy@Example.com ", PASSWORD);
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);
  });

  test("ignores a kept link it can't read", async () => {
    const store = memoryStore({ nonsense: true } as unknown as StoredLink);
    await linkerWith(store).link(EMAIL, PASSWORD);
    assert.deepEqual(asked, NEW_LINK);
  });
});

describe("the shared Joysound link", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-link-test-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function shared() {
    const config = createConfigStore(path.join(dir, "config.yaml"));
    config.update({ joysoundEmail: EMAIL, joysoundPassword: PASSWORD });
    const store = memoryStore();
    const linker = linkerWith(store);
    // As services.ts wires them.
    config.onChange(({ keys }) => {
      if (keys.includes("joysoundEmail")) {
        linker.forgetOtherAccounts(config.get().joysoundEmail);
      }
    });
    const { joysound } = createCredentialProviders({
      store: config,
      damLogin: async () => ({}),
      joysoundLogin: (email, password) => linker.link(email, password),
    });
    return { config, store, joysound };
  }

  test("concurrent requests share one link", async () => {
    const { joysound } = shared();
    const links = await Promise.all([joysound(), joysound(), joysound()]);
    assert.ok(links.every((link) => link === links[0]));
    assert.deepEqual(asked, NEW_LINK);
  });

  test("a new account drops the old account's link and links its own", async () => {
    const { config, store, joysound } = shared();
    await joysound();
    config.update({ joysoundEmail: "other@example.com" });
    // Dropped at once, not only when it's next used.
    assert.equal(store.value, null);
    site.codes.clear();
    asked.length = 0;
    // other@example.com's password differs from the fake site's: the
    // link fails, but it never used the old code.
    await assert.rejects(joysound(), /login rejected/);
    assert.equal(asked[0], "POST /api/v1/linkCode");
    assert.deepEqual(store.value, {
      account: "other@example.com",
      linkCode: "SECRETCODE1",
    });
  });

  test("a new password keeps the account's link", async () => {
    const { config, store, joysound } = shared();
    const first = await joysound();
    config.update({ joysoundPassword: "new-pw" });
    asked.length = 0;
    assert.deepEqual(await joysound(), first);
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);
    assert.equal(store.value?.linkCode, first.linkCode);
  });
});

describe("createJoysoundLinker's status and test", () => {
  // Only signing in and linkInfo: no code issued, authorized or unlinked.
  const NOTHING_CHANGED = (paths: string[]) =>
    paths.every(
      (p) =>
        !p.includes("/api/v1/linkCode") &&
        !p.includes("/mypage/tvlink") &&
        !p.toLowerCase().includes("unlink"),
    );

  test("say how the kept link stands, changing nothing", async () => {
    const store = memoryStore();
    const linker = linkerWith(store);
    assert.deepEqual(await linker.status(EMAIL), { state: "none" });

    await linker.link(EMAIL, PASSWORD);
    asked.length = 0;
    assert.deepEqual(await linker.status(EMAIL), {
      state: "linked",
      membershipType: "PAID",
    });
    site.codes.get("SECRETCODE1")!.linked = false;
    assert.deepEqual(await linker.status(EMAIL), { state: "pending" });
    site.codes.get("SECRETCODE1")!.valid = false;
    assert.deepEqual(await linker.status(EMAIL), { state: "ended" });
    assert.deepEqual(await linker.status("other@example.com"), {
      state: "none",
    });
    assert.ok(NOTHING_CHANGED(asked), asked.join(", "));
    assert.deepEqual(store.value, { account: EMAIL, linkCode: "SECRETCODE1" });
  });

  test("test signs in and describes the link, linking nothing", async () => {
    const store = memoryStore();
    const linker = linkerWith(store);
    assert.match(
      await linker.test(EMAIL, PASSWORD),
      /links itself to this account, as a JOYSOUND TV device/,
    );
    assert.ok(NOTHING_CHANGED(asked), asked.join(", "));
    assert.equal(store.value, null);
    assert.equal(site.codes.size, 0);

    await linker.link(EMAIL, PASSWORD);
    asked.length = 0;
    assert.equal(
      await linker.test(EMAIL, PASSWORD),
      "karafriends is linked to this account, a paid member.",
    );
    assert.ok(NOTHING_CHANGED(asked), asked.join(", "));

    site.membership = "FREE";
    await assert.rejects(
      linker.test(EMAIL, PASSWORD),
      (err) =>
        err instanceof LoginWarning &&
        /isn't a paid member \(membership: FREE\)/.test(err.message),
    );
  });

  test("test fails on a wrong password", async () => {
    await assert.rejects(
      linkerWith(memoryStore()).test(EMAIL, "wrong"),
      /login rejected \(result 1\)/,
    );
  });

  test("linkStatusNote says what karafriends will do", () => {
    assert.match(linkStatusNote({ state: "pending" }), /isn't finished/);
    assert.match(
      linkStatusNote({ state: "ended" }),
      /has ended; it links again/,
    );
    assert.throws(
      () => linkStatusNote({ state: "linked", membershipType: null }),
      /membership: none/,
    );
  });
});
