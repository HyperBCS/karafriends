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
  redirectTarget,
  TAKEN_RETRY_MS,
  TvLinkTakenError,
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
  // Whether another TV app holds the account's link (one at a time).
  otherTvLinked: boolean;
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
  // The link page, as sound-cafe's (2026-10-29): /mypage/tvlink/<code>
  // keeps the code in the session and redirects, with an absolute URL, to
  // /mypage/tvlink, which links it (and is a 404 without one); an unknown
  // code goes to /mypage/tvlink/linkCodeError. Signed out, both go to the
  // login page.
  const redirect = (location: string, cookie?: string) => {
    res.writeHead(302, {
      Location: location,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    });
    res.end();
  };
  if (route === "GET /mypage/tvlink/linkCodeError") {
    return html(res, "<html>リンクコードが正しくありません</html>");
  }
  if (route === "GET /mypage/tvlink/linkedConfirm") {
    return html(
      res,
      "<html>すでに紐づいているテレビアプリが存在します。リンクを切り替えますか？</html>",
    );
  }
  if (route === "GET /mypage/tvlink") {
    if (!signedIn) return redirect("/login");
    const kept = (req.headers.cookie ?? "").match(/TVLINK=([^;]+)/)?.[1];
    const code = kept && site.codes.get(kept);
    if (!code) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end("<html>not found</html>");
    }
    if (site.linkPageLinks) code.linked = true;
    return html(res, "<html>テレビアプリとの連携が完了しました</html>", {
      "Set-Cookie": "TVLINK=; Max-Age=0; Path=/",
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/mypage/tvlink/")) {
    if (!signedIn) return redirect("/login");
    const linkCode = decodeURIComponent(
      url.pathname.slice("/mypage/tvlink/".length),
    );
    if (!site.codes.get(linkCode)?.valid) {
      return redirect(`${base}/mypage/tvlink/linkCodeError`);
    }
    // Another TV app: the page asks first; ?force=1 (its "switch") unlinks it.
    if (site.otherTvLinked) {
      if (url.searchParams.get("force") !== "1") {
        return redirect(
          `${base}/mypage/tvlink/linkedConfirm`,
          `TVLINK=${linkCode}; Path=/`,
        );
      }
      site.otherTvLinked = false;
    }
    return redirect(`${base}/mypage/tvlink`, `TVLINK=${linkCode}; Path=/`);
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
      const { pathname, search } = new URL(req.url ?? "/", base);
      asked.push(`${req.method} ${pathname}${search}`);
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
    otherTvLinked: false,
    loginSticks: true,
  };
});

function memoryStore(initial: StoredLink | null = null) {
  const store: LinkStore & { value: StoredLink | null } = {
    value: initial,
    load: async () => store.value,
    save: async (link) => {
      store.value = link;
    },
  };
  return store;
}

const linkerWith = (store: LinkStore, now?: () => number) =>
  createJoysoundLinker({ store, baseURL: base, now });

// What linking a new code asks, in order.
const NEW_LINK = [
  "POST /api/v1/linkCode",
  "GET /login",
  "POST /login/check",
  "POST /login",
  "GET /",
  "GET /mypage/tvlink/SECRETCODE1",
  "GET /mypage/tvlink",
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
    assert.match(
      String(err),
      /didn't link karafriends to the account: its link code is still not linked after authorizing it \(the link page ended on \/mypage\/tvlink\)/,
    );
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

  // The last forgetOtherAccounts the config change started.
  let forgetting: Promise<void> = Promise.resolve();

  function shared() {
    const config = createConfigStore(path.join(dir, "config.yaml"));
    config.update({ joysoundEmail: EMAIL, joysoundPassword: PASSWORD });
    const store = memoryStore();
    const linker = linkerWith(store);
    // As services.ts wires them.
    config.onChange(({ keys }) => {
      if (keys.includes("joysoundEmail")) {
        forgetting = linker.forgetOtherAccounts(config.get().joysoundEmail);
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
    await forgetting;
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
    const before = await linker.test(EMAIL, PASSWORD);
    assert.match(before.note, /Not linked as a TV app yet/);
    // Not linked yet: the link may be another TV app's, so Switch is offered.
    assert.equal(before.canSwitchLink, true);
    assert.ok(NOTHING_CHANGED(asked), asked.join(", "));
    assert.equal(store.value, null);
    assert.equal(site.codes.size, 0);

    await linker.link(EMAIL, PASSWORD);
    asked.length = 0;
    assert.deepEqual(await linker.test(EMAIL, PASSWORD), {
      note: "Linked as a TV app (paid membership).",
    });
    assert.ok(NOTHING_CHANGED(asked), asked.join(", "));

    site.membership = "FREE";
    await assert.rejects(
      linker.test(EMAIL, PASSWORD),
      (err) =>
        err instanceof LoginWarning &&
        /has no paid membership \(FREE\)/.test(err.message),
    );
  });

  test("test fails on a wrong password", async () => {
    await assert.rejects(
      linkerWith(memoryStore()).test(EMAIL, "wrong"),
      /login rejected \(result 1\)/,
    );
  });

  test("linkStatusNote says what karafriends will do", () => {
    assert.match(linkStatusNote({ state: "pending" }).note, /TV link pending/);
    assert.match(linkStatusNote({ state: "ended" }).note, /TV link expired/);
    assert.throws(
      () => linkStatusNote({ state: "linked", membershipType: null }),
      /no paid membership \(none\)/,
    );
  });
});

describe("redirectTarget", () => {
  const base = new URL("https://www.sound-cafe.jp");

  test("takes sound-cafe's http:// redirects back to https", () => {
    // What the link page sent on 2026-10-29.
    assert.equal(
      redirectTarget(
        "http://www.sound-cafe.jp/mypage/tvlink/linkCodeError",
        new URL("https://www.sound-cafe.jp/mypage/tvlink/X"),
        base,
      ).toString(),
      "https://www.sound-cafe.jp/mypage/tvlink/linkCodeError",
    );
    assert.equal(
      redirectTarget(
        "/login",
        new URL("https://www.sound-cafe.jp/mypage/tvlink"),
        base,
      ).toString(),
      "https://www.sound-cafe.jp/login",
    );
  });

  test("refuses another site", () => {
    assert.throws(
      () =>
        redirectTarget(
          "https://example.com/mypage",
          new URL("https://www.sound-cafe.jp/mypage/tvlink/X"),
          base,
        ),
      /another site \(example\.com\)/,
    );
  });
});

describe("the link page's redirects", () => {
  test("keep the session's cookies, and an unknown code isn't linked", async () => {
    const store = memoryStore({ account: EMAIL, linkCode: "NOTISSUED" });
    // linkInfo says the kept code is no longer valid: a new one is linked,
    // through the redirect, with the cookie set on the way.
    const link = await linkerWith(store).link(EMAIL, PASSWORD);
    assert.equal(link.linkCode, "SECRETCODE1");
    assert.ok(asked.includes("GET /mypage/tvlink"));
    assert.equal(site.codes.get("SECRETCODE1")?.linked, true);
  });
});

describe("another TV app holding the link", () => {
  const isTaken = (err: unknown) =>
    err instanceof TvLinkTakenError &&
    err.status === 409 &&
    /Settings › Accounts/.test(err.message);

  test("isn't unlinked: the link fails, saying so, and waits a while to try again", async () => {
    site.otherTvLinked = true;
    let time = 1_000;
    const store = memoryStore();
    const linker = linkerWith(store, () => time);
    await assert.rejects(linker.link(EMAIL, PASSWORD), isTaken);
    assert.equal(site.otherTvLinked, true);
    assert.ok(!asked.some((p) => p.includes("force")), asked.join(", "));
    assert.deepEqual(asked.slice(-2), [
      "GET /mypage/tvlink/SECRETCODE1",
      "GET /mypage/tvlink/linkedConfirm",
    ]);
    // The code is kept, for when the link can be made.
    assert.deepEqual(store.value, { account: EMAIL, linkCode: "SECRETCODE1" });

    // Meanwhile, only linkInfo: no sign-in for every search.
    asked.length = 0;
    await assert.rejects(linker.link(EMAIL, PASSWORD), isTaken);
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);

    // Later, the link page again, with the same code.
    time += TAKEN_RETRY_MS;
    asked.length = 0;
    await assert.rejects(linker.link(EMAIL, PASSWORD), isTaken);
    assert.ok(asked.includes("GET /mypage/tvlink/SECRETCODE1"));
    assert.ok(!asked.includes("POST /api/v1/linkCode"));
    assertNoSecrets();
  });

  test("Test login says so, offering the switch, and changes nothing", async () => {
    site.otherTvLinked = true;
    const linker = linkerWith(memoryStore());
    await assert.rejects(linker.link(EMAIL, PASSWORD), isTaken);
    asked.length = 0;
    await assert.rejects(
      linker.test(EMAIL, PASSWORD),
      (err) =>
        err instanceof LoginWarning &&
        err.canSwitchLink &&
        /another TV app is linked/.test(err.message),
    );
    assert.ok(
      !asked.some((p) => p.includes("/mypage/tvlink")),
      asked.join(", "),
    );
    assert.equal(site.otherTvLinked, true);
  });

  test("switchLink takes the link, and then it's kept", async () => {
    site.otherTvLinked = true;
    const store = memoryStore();
    const linker = linkerWith(store);
    await assert.rejects(linker.link(EMAIL, PASSWORD), isTaken);

    asked.length = 0;
    assert.equal(
      await linker.switchLink(EMAIL, PASSWORD),
      "Linked as a TV app (paid membership).",
    );
    // As a browser: the link page, its question, then its switch.
    const page = asked.indexOf("GET /mypage/tvlink/SECRETCODE1");
    assert.equal(asked[page + 1], "GET /mypage/tvlink/linkedConfirm");
    assert.equal(asked[page + 2], "GET /mypage/tvlink/SECRETCODE1?force=1");
    // Signed in once.
    assert.equal(asked.filter((p) => p === "POST /login").length, 1);
    assert.ok(!asked.includes("POST /api/v1/linkCode"));
    assert.equal(site.otherTvLinked, false);
    assert.equal(site.codes.get("SECRETCODE1")?.linked, true);

    // The next request uses it, without waiting out the retry.
    asked.length = 0;
    assert.deepEqual(await linker.link(EMAIL, PASSWORD), {
      linkCode: "SECRETCODE1",
      membershipType: "PAID",
    });
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);
  });

  test("switchLink with no other TV app links as usual, without the switch", async () => {
    const linker = linkerWith(memoryStore());
    assert.equal(
      await linker.switchLink(EMAIL, PASSWORD),
      "Linked as a TV app (paid membership).",
    );
    assert.deepEqual(asked, NEW_LINK);
  });

  test("switchLink on a link karafriends already holds only checks it", async () => {
    const store = memoryStore();
    const linker = linkerWith(store);
    await linker.link(EMAIL, PASSWORD);
    asked.length = 0;
    await linker.switchLink(EMAIL, PASSWORD);
    assert.deepEqual(asked, ["POST /api/v1/linkInfo"]);
  });
});
