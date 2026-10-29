// Runs on Node's test runner through tsx (yarn test:unit). Whether DAM's
// and Joysound's songs are on: the startup check, what each failure means,
// and the tries again while a service can't be reached.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { FetchError } from "node-fetch";

import type { CatalogStatus, LoginService } from "../common/api";
import {
  catalogProblem,
  type CatalogStatuses,
  createCatalogs,
  fakeCatalogs,
} from "./catalogs";
import { LoginRejectedError, LoginWarning, NoLoginError } from "./credentials";
import { MinseiStatusError } from "./damApi";
import { HttpStatusError } from "./http";
import { TvLinkTakenError } from "./joysoundLink";
import { TimeoutError } from "./timeout";

beforeEach(() => {
  for (const level of ["info", "warn"] as const) {
    mock.method(console, level, () => {});
  }
});
afterEach(() => mock.restoreAll());

describe("catalogProblem", () => {
  test("no login: off", () => {
    assert.deepEqual(catalogProblem("dam", new NoLoginError("DAM")), {
      state: "off",
    });
  });

  test("a refused login waits for the host", () => {
    for (const [service, err] of [
      ["dam", new MinseiStatusError("1001", "ログインに失敗しました")],
      ["joysound", new LoginRejectedError("Joysound login rejected")],
    ] as const) {
      const problem = catalogProblem(service, err);
      assert.equal(problem.state, "failed");
      assert.match(
        "reason" in problem ? problem.reason : "",
        /refused the login: check the (username|email) and password/,
      );
    }
  });

  test("another TV app's link, and a warning, say so; the link can be switched", () => {
    assert.deepEqual(catalogProblem("joysound", new TvLinkTakenError()), {
      state: "failed",
      reason:
        "Another TV app is linked to the Joysound account, which links one at a time. Switch the link to karafriends in Settings › Accounts.",
      canSwitchLink: true,
    });
    assert.deepEqual(
      catalogProblem("joysound", new LoginWarning("Not a paid member.")),
      { state: "failed", reason: "Not a paid member." },
    );
  });

  test("a 403 means no Japanese address: the VPN", () => {
    assert.deepEqual(
      catalogProblem("dam", new HttpStatusError(403, "https://x/login")),
      {
        state: "unreachable",
        reason:
          "DAM refused this connection: it only answers addresses in Japan. Turn on the VPN to Japan.",
      },
    );
  });

  test("no connection, no answer, or the service's own failure: unreachable", () => {
    for (const err of [
      new TimeoutError("DAM's sign-in", 45_000),
      new FetchError("getaddrinfo ENOTFOUND", "system"),
      new HttpStatusError(503, "https://x"),
    ]) {
      assert.deepEqual(catalogProblem("joysound", err), {
        state: "unreachable",
        reason:
          "Can't reach Joysound. Check the internet connection and the VPN to Japan.",
      });
    }
  });

  test("anything else: failed, without the error's own words", () => {
    const problem = catalogProblem(
      "joysound",
      new Error("404 from https://www.sound-cafe.jp/mypage/tvlink/SECRETCODE"),
    );
    assert.equal(problem.state, "failed");
    assert.doesNotMatch(JSON.stringify(problem), /SECRETCODE/);
  });
});

describe("fakeCatalogs", () => {
  test("names the catalogs that are on; unset, none is faked", () => {
    assert.equal(fakeCatalogs(undefined), null);
    assert.deepEqual([...fakeCatalogs("dam, joysound")!], ["dam", "joysound"]);
    assert.deepEqual([...fakeCatalogs("joysound")!], ["joysound"]);
    assert.deepEqual([...fakeCatalogs("")!], []);
  });
});

describe("createCatalogs", () => {
  // Sign-ins that answer as each test says, and the statuses seen.
  function setUp(
    options: {
      logins?: Partial<Record<LoginService, boolean>>;
      enabled?: Partial<Record<LoginService, boolean>>;
      fake?: ReadonlySet<LoginService> | null;
    } = {},
  ) {
    const outcomes: Record<LoginService, (() => Promise<void>)[]> = {
      dam: [],
      joysound: [],
    };
    const signIns: LoginService[] = [];
    const forgotten: LoginService[] = [];
    const seen: CatalogStatuses[] = [];
    const signIn = (service: LoginService) => async () => {
      signIns.push(service);
      const next = outcomes[service].shift();
      if (next) await next();
    };
    const catalogs = createCatalogs({
      enabled: (service) => options.enabled?.[service] ?? true,
      hasLogin: (service) => options.logins?.[service] ?? true,
      signIn: { dam: signIn("dam"), joysound: signIn("joysound") },
      forget: {
        dam: () => forgotten.push("dam"),
        joysound: () => forgotten.push("joysound"),
      },
      onChange: (statuses) => seen.push(statuses),
      now: () => 1000,
      retryMs: [10, 30],
      fake: options.fake,
    });
    const states = (service: LoginService) =>
      seen.map((statuses) => statuses[service].state);
    return { catalogs, outcomes, signIns, forgotten, seen, states };
  }

  test("a login that signs in turns its catalog on", async () => {
    const { catalogs, states } = setUp();
    assert.deepEqual(await catalogs.check("dam"), { state: "on" });
    assert.equal(catalogs.isOn("dam"), true);
    assert.equal(catalogs.isOn("joysound"), false);
    assert.deepEqual(states("dam"), ["checking", "on"]);
  });

  test("no login: off, without signing in", async () => {
    const { catalogs, signIns } = setUp({ logins: { joysound: false } });
    assert.deepEqual(await catalogs.check("joysound"), { state: "off" });
    assert.deepEqual(signIns, []);
  });

  test("a refused login stays failed until checked again", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { catalogs, outcomes, signIns } = setUp();
    outcomes.dam.push(async () => {
      throw new LoginRejectedError("wrong password");
    });
    const status = await catalogs.check("dam");
    assert.equal(status.state, "failed");
    t.mock.timers.tick(60_000);
    assert.deepEqual(signIns, ["dam"]);
  });

  test("an unreachable service is tried again by itself, then comes on", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { catalogs, outcomes, signIns, states } = setUp();
    const geoBlocked = async () => {
      throw new HttpStatusError(403, "https://x");
    };
    outcomes.joysound.push(geoBlocked, geoBlocked);
    const first = await catalogs.check("joysound");
    assert.equal(first.state, "unreachable");
    assert.equal(
      (first as Extract<CatalogStatus, { state: "unreachable" }>).retryAt,
      1010,
    );
    // The waits: 10, then 30 (the last one repeats).
    t.mock.timers.tick(10);
    await flush();
    assert.equal(catalogs.statuses().joysound.state, "unreachable");
    assert.equal(
      (
        catalogs.statuses().joysound as Extract<
          CatalogStatus,
          { state: "unreachable" }
        >
      ).retryAt,
      1030,
    );
    t.mock.timers.tick(30);
    await flush();
    assert.deepEqual(catalogs.statuses().joysound, { state: "on" });
    assert.deepEqual(signIns, ["joysound", "joysound", "joysound"]);
    // Tried again quietly: no "checking" in between.
    assert.deepEqual(states("joysound"), [
      "checking",
      "unreachable",
      "unreachable",
      "on",
    ]);
    catalogs.stop();
  });

  test("a fresh check drops the kept session first", async () => {
    const { catalogs, forgotten } = setUp();
    await catalogs.check("dam");
    await catalogs.check("dam", { fresh: true });
    assert.deepEqual(forgotten, ["dam"]);
  });

  test("a newer check's outcome wins over an older one's", async () => {
    const { catalogs, outcomes } = setUp();
    let refuse!: () => void;
    outcomes.dam.push(
      () =>
        new Promise<void>((_, reject) => {
          refuse = () => reject(new LoginRejectedError("old password"));
        }),
    );
    const older = catalogs.check("dam");
    const newer = await catalogs.check("dam");
    assert.deepEqual(newer, { state: "on" });
    refuse();
    await older;
    assert.deepEqual(catalogs.statuses().dam, { state: "on" });
  });

  test("turned off by the host: disabled, without signing in; tries again stop", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const enabled = { dam: true, joysound: true };
    const { catalogs, outcomes, signIns } = setUp({ enabled });
    outcomes.dam.push(async () => {
      throw new HttpStatusError(403, "https://x");
    });
    assert.equal((await catalogs.check("dam")).state, "unreachable");
    enabled.dam = false;
    assert.deepEqual(await catalogs.check("dam"), { state: "disabled" });
    assert.equal(catalogs.isOn("dam"), false);
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(signIns, ["dam"]);
    assert.deepEqual(catalogs.statuses().dam, { state: "disabled" });
  });

  test("faked (the e2e tests), a catalog turned off is still off", async () => {
    const { catalogs } = setUp({
      enabled: { joysound: false },
      fake: new Set(["dam", "joysound"]),
    });
    assert.deepEqual(await catalogs.check("joysound"), { state: "disabled" });
    assert.deepEqual(await catalogs.check("dam"), { state: "on" });
  });

  test("faked (the e2e tests): on as named, with nothing signed in", async () => {
    const { catalogs, signIns } = setUp({ fake: new Set(["joysound"]) });
    assert.deepEqual(await catalogs.check("dam"), { state: "off" });
    assert.deepEqual(await catalogs.check("joysound"), { state: "on" });
    assert.deepEqual(signIns, []);
  });
});

// Lets the promises a timer's callback started settle.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
