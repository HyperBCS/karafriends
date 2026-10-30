// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Call,
  createSettingsActions,
  type Loaded,
  type Message,
  type Section,
} from "./actions";

const LOADED = {
  settings: {
    damUsername: "",
    damPassword: "",
    useLowBitrateUrl: false,
    joysoundEmail: "",
    joysoundPassword: "",
    adminPasswordSet: false,
    supervisedMode: false,
    everyoneIsAdmin: false,
    paxSongQueueLimit: 0,
    remoconPort: 8080,
  },
  isFirstRun: true,
  needsRestart: false,
  loadProblem: null,
} as unknown as Loaded;

// The app as the actions see it: each method answers as `answers` says,
// and every call is kept. What each section shows is kept too, in order.
function setUp(answers: Record<string, (input: any) => unknown>) {
  const calls: [string, unknown][] = [];
  const said: [Section, Message | null][] = [];
  const call = (async (method: string, input: unknown) => {
    calls.push([method, input]);
    if (method === "getSettings") return LOADED;
    const answer = answers[method];
    if (!answer) throw new Error(`${method} isn't faked`);
    return answer(input);
  }) as Call;
  const actions = createSettingsActions({
    call,
    files: {
      saveTextFile: async () => true,
      openTextFile: async () => "damUsername: imported\n",
    },
    say: (section, message) => said.push([section, message]),
    setLoaded: () => undefined,
    onImported: () => undefined,
  });
  const shown = (section: Section) =>
    said.filter(([at]) => at === section).map(([, message]) => message?.text);
  const methods = () => calls.map(([method]) => method);
  const last = (section: Section) =>
    said.filter(([at]) => at === section).at(-1)?.[1];
  return { actions, shown, methods, last };
}

const refused = () => ({
  ok: false,
  problems: ["damPassword must be text of at most 1000 characters"],
});

describe("Settings' actions", () => {
  test("Test login after a save tests what was just saved", async () => {
    const { actions, shown, methods } = setUp({
      setSettings: () => ({ ok: true, needsRestart: false }),
      testLogin: () => ({ ok: true }),
    });
    void actions.save("dam", { damPassword: "new" });
    await actions.testLogin("dam");
    assert.deepEqual(methods(), ["setSettings", "getSettings", "testLogin"]);
    assert.deepEqual(shown("dam"), [
      "Saved.",
      "Signing in…",
      "Signed in to DAM.",
    ]);
  });

  test("Test login shows the note on Joysound's link after signing in", async () => {
    const { actions, last } = setUp({
      testLogin: () => ({
        ok: true,
        note: "Linked as a TV app (paid membership).",
      }),
    });
    await actions.testLogin("joysound");
    assert.equal(
      last("joysound")?.text,
      "Signed in to Joysound. Linked as a TV app (paid membership).",
    );
    assert.notEqual(last("joysound")?.tone, "problem");
  });

  test("Test login offers the switch when another TV app holds Joysound's link, and Switch says how it went", async () => {
    const { actions, last, methods } = setUp({
      testLogin: () => ({
        ok: false,
        reason: "Signed in, but another TV app is linked.",
        canSwitchLink: true,
      }),
      switchJoysoundLink: () => ({
        ok: true,
        note: "Linked as a TV app (paid membership).",
      }),
    });
    await actions.testLogin("joysound");
    assert.deepEqual(last("joysound"), {
      text: "Signed in, but another TV app is linked.",
      tone: "problem",
      offersSwitch: true,
    });
    await actions.switchJoysoundLink();
    assert.equal(methods().at(-1), "switchJoysoundLink");
    assert.deepEqual(last("joysound"), {
      text: "Linked as a TV app (paid membership).",
    });
  });

  test("Test login doesn't run after a save that failed, and the save's message stays", async () => {
    const { actions, shown, methods } = setUp({
      setSettings: refused,
      testLogin: () => ({ ok: true }),
    });
    void actions.save("dam", { damPassword: "x".repeat(1001) });
    await actions.testLogin("dam");
    assert.deepEqual(methods(), ["setSettings"]);
    assert.deepEqual(shown("dam"), [
      "damPassword must be text of at most 1000 characters",
    ]);
    // Clicked again: still not, while the field holds what didn't save.
    await actions.testLogin("dam");
    assert.deepEqual(methods(), ["setSettings"]);
  });

  test("Test login runs again once the login saves", async () => {
    let ok = false;
    const { actions, shown, methods } = setUp({
      setSettings: () => (ok ? { ok: true, needsRestart: false } : refused()),
      testLogin: () => ({ ok: true }),
    });
    await actions.save("dam", { damPassword: "x".repeat(1001) });
    ok = true;
    await actions.save("dam", { damPassword: "fixed" });
    await actions.testLogin("dam");
    assert.equal(methods().at(-1), "testLogin");
    assert.equal(shown("dam").at(-1), "Signed in to DAM.");
  });

  test("a save that throws counts as not saved, as a refusal does", async () => {
    const { actions, methods } = setUp({
      setSettings: () => {
        throw new Error("Couldn't save config.yaml: EACCES");
      },
      testLogin: () => ({ ok: true }),
    });
    assert.equal(await actions.save("joysound", { joysoundEmail: "a" }), false);
    await actions.testLogin("joysound");
    assert.deepEqual(methods(), ["setSettings"]);
  });

  test("failedSince says whether a save asked for since then didn't save", async () => {
    let ok = true;
    const { actions } = setUp({
      setSettings: () => (ok ? { ok: true, needsRestart: false } : refused()),
    });
    // Nothing asked for since: answered at once.
    const none = actions.saveCount();
    assert.equal(await actions.failedSince(none), false);

    const before = actions.saveCount();
    void actions.save("queue", { supervisedMode: true });
    assert.equal(await actions.failedSince(before), false);

    ok = false;
    const later = actions.saveCount();
    void actions.save("network", { remoconPort: 80800 });
    assert.equal(await actions.failedSince(later), true);
    // A failure before `from` doesn't count.
    assert.equal(await actions.failedSince(actions.saveCount()), false);
  });

  test("a number that isn't one counts as not saved", async () => {
    const { actions, shown, methods } = setUp({});
    const from = actions.saveCount();
    actions.saveNumber("network", "remoconPort", "80x");
    assert.equal(await actions.failedSince(from), true);
    assert.deepEqual(methods(), []);
    assert.deepEqual(shown("network"), ["Port must be a whole number."]);
  });

  test("a refusal names the setting it is about, so its field can save the saved value again", async () => {
    const { actions, last } = setUp({
      setSettings: () => ({
        ok: false,
        problems: ["paxSongQueueLimit must be a whole number from 0 to 1000"],
      }),
    });
    await actions.save("queue", { paxSongQueueLimit: 1001 });
    assert.deepEqual(last("queue"), {
      text: "Queue limit per phone must be a whole number from 0 to 1000",
      tone: "problem",
      refused: "paxSongQueueLimit",
    });
    actions.saveNumber("network", "remoconPort", "abc");
    assert.equal(last("network")?.refused, "remoconPort");
    // A save of two settings names neither (the checkboxes go back by
    // themselves).
    await actions.save("queue", {
      supervisedMode: true,
      everyoneIsAdmin: true,
    });
    assert.equal(last("queue")?.refused, undefined);
  });

  test("an import says it's busy while the app tests its logins, and what it did after", async () => {
    let answer: (output: unknown) => void = () => undefined;
    const { actions, shown, last } = setUp({
      importConfig: () => new Promise((resolve) => (answer = resolve)),
    });
    const done = actions.importConfig();
    await new Promise((resolve) => setTimeout(resolve));
    assert.deepEqual(last("config"), {
      text: "Importing…",
      tone: "busy",
    });
    answer({ ok: true, problems: ["The DAM login didn't sign in"] });
    await done;
    assert.deepEqual(shown("config"), ["Importing…", "Imported."]);
    assert.deepEqual(last("config")?.list, ["The DAM login didn't sign in"]);
  });
});
