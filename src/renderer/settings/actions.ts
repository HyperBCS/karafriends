// What Settings' fields and buttons do: saves, login tests, the admin
// password, export and import. No React and no window here, so the chain can
// be tested with a fake `call` (actions.test.ts).
import type {
  ApiInput,
  ApiMethod,
  ApiOutput,
  LoginService,
  Settings as SavedSettings,
  SettingsChanges,
} from "../../common/api";
import type { DisplayFiles } from "../../common/ipc";
import type { SettingsTab } from "./tabs";

export type Loaded = ApiOutput<"getSettings">;

// A part of a tab with its own message under it.
export type Section =
  | LoginService
  | "admin"
  | "queue"
  | "network"
  | "sound"
  | "mics"
  | "tools"
  | "config";

// The tab each section's messages show on.
export const SECTION_TABS: Record<Section, SettingsTab> = {
  dam: "accounts",
  joysound: "accounts",
  admin: "party",
  queue: "party",
  network: "party",
  sound: "sound",
  mics: "sound",
  tools: "advanced",
  config: "advanced",
};

// The tab each setting is on, to mark the ones an import changed.
export const SETTING_TABS: Record<keyof SavedSettings, SettingsTab> = {
  damEnabled: "accounts",
  joysoundEnabled: "accounts",
  damUsername: "accounts",
  damPassword: "accounts",
  useLowBitrateUrl: "accounts",
  joysoundEmail: "accounts",
  joysoundPassword: "accounts",
  adminPasswordSet: "party",
  supervisedMode: "party",
  everyoneIsAdmin: "party",
  paxSongQueueLimit: "party",
  remoconPort: "party",
};

// What happened in a section, under it.
export interface Message {
  text: string;
  list?: string[];
  tone?: "busy" | "problem";
  // The setting a refusal is about: its field saves again even unchanged,
  // so the saved value put back clears it.
  refused?: keyof SettingsChanges;
  // karafriends isn't the Joysound account's TV app (another may hold the
  // link): the section offers to switch it to karafriends
  // (switchJoysoundLink).
  offersSwitch?: boolean;
}

export const SERVICE_NAMES = { dam: "DAM", joysound: "Joysound" } as const;

// The app names a setting by its config.yaml key when it refuses a value;
// this screen, by its label.
export const LABELS: Record<string, string> = {
  paxSongQueueLimit: "Songs per phone",
  remoconPort: "Port",
};

export const labelled = (problem: string) =>
  problem.replace(/^\w+/, (key) => LABELS[key] ?? key);

// An error's message, to show.
export const errorText = (err: unknown) =>
  String((err as Error)?.message ?? err);

export const problemMessage = (err: unknown): Message => ({
  text: errorText(err),
  tone: "problem",
});

export type Call = <M extends ApiMethod>(
  method: M,
  input: ApiInput<M>,
) => Promise<ApiOutput<M>>;

export interface SettingsDeps {
  call: Call;
  files: DisplayFiles;
  // Shows a message under a section; null clears it.
  say: (section: Section, message: Message | null) => void;
  // The settings as just loaded.
  setLoaded: (loaded: Loaded) => void;
  // The tabs an import changed.
  onImported: (tabs: SettingsTab[]) => void;
}

export type SettingsActions = ReturnType<typeof createSettingsActions>;

export function createSettingsActions(deps: SettingsDeps) {
  const { call, say } = deps;
  // Saves, tests and imports run one after another, so a Test login
  // clicked right after typing tests what was just saved.
  let chain: Promise<void> = Promise.resolve();

  const reload = async () => {
    const settings = await call("getSettings", {});
    deps.setLoaded(settings);
    return settings;
  };

  // Runs task after the ones before it, and shows what it says (or its
  // error) under the section; undefined leaves the message as it is.
  // Settles when it has.
  const act = (
    section: Section,
    task: () => Promise<Message | null | undefined>,
  ) =>
    (chain = chain.then(async () => {
      try {
        const message = await task();
        if (message !== undefined) say(section, message);
      } catch (err) {
        say(section, problemMessage(err));
      }
    }));

  // Each save is numbered as it is asked for. The sections whose last save
  // didn't save (a field there holds a value the app doesn't), and the
  // number of the last save that didn't.
  let saves = 0;
  let lastUnsaved = -1;
  const unsaved = new Set<Section>();
  const settle = (section: Section, number: number, saved: boolean) => {
    if (saved) {
      unsaved.delete(section);
    } else {
      unsaved.add(section);
      lastUnsaved = Math.max(lastUnsaved, number);
    }
  };

  // Whether it saved.
  const save = (section: Section, changes: SettingsChanges) => {
    const number = saves++;
    const keys = Object.keys(changes) as (keyof SettingsChanges)[];
    const refused = keys.length === 1 ? keys[0] : undefined;
    let saved = false;
    return act(section, async () => {
      let result;
      try {
        result = await call("setSettings", { settings: changes });
      } catch (err) {
        return { ...problemMessage(err), refused };
      }
      if (!result.ok) {
        return {
          text: result.problems.map(labelled).join(" "),
          tone: "problem",
          refused,
        };
      }
      saved = true;
      await reload();
      return { text: "Saved." };
    }).then(() => {
      settle(section, number, saved);
      return saved;
    });
  };

  // A whole number, or a message saying it isn't one.
  const saveNumber = (
    section: Section,
    key: "paxSongQueueLimit" | "remoconPort",
    value: string,
  ) => {
    if (!/^\d+$/.test(value.trim())) {
      settle(section, saves++, false);
      say(section, {
        text: `${LABELS[key]}: enter a whole number.`,
        tone: "problem",
        refused: key,
      });
      return;
    }
    save(section, { [key]: Number(value) });
  };

  // After the saves before it: if the login's last one didn't save, the
  // test would sign in with the old login, so it doesn't run, and the
  // save's message stays.
  const testLogin = (service: LoginService) =>
    act(service, async () => {
      if (unsaved.has(service)) return undefined;
      say(service, { text: "Signing in…", tone: "busy" });
      const result = await call("testLogin", { service });
      if (!result.ok) {
        return result.canSwitchLink
          ? { text: result.reason, tone: "problem", offersSwitch: true }
          : { text: result.reason, tone: "problem" };
      }
      const signedIn = `Signed in to ${SERVICE_NAMES[service]}.`;
      const text = result.note ? `${signedIn} ${result.note}` : signedIn;
      return result.canSwitchLink ? { text, offersSwitch: true } : { text };
    });

  // How many saves were asked for so far, to give failedSince.
  const saveCount = () => saves;

  // Whether a save asked for since saveCount() was `from` didn't save, once
  // it has run: Settings stays open to say why.
  const failedSince = async (from: number) => {
    if (saves === from) return false;
    await chain;
    return lastUnsaved >= from;
  };

  // `done` runs once it is set, before the settings load again.
  const setAdminPassword = (password: string, done: () => void) =>
    act("admin", async () => {
      await call("setAdminPassword", { password });
      done();
      await reload();
      return {
        text: password
          ? "Saved. Phones signed in as admins must sign in again."
          : "Cleared. No phone can be an admin now.",
      };
    });

  // Links karafriends to the Joysound account, unlinking the other TV app.
  // After the saves before it, as Test login.
  const switchJoysoundLink = () =>
    act("joysound", async () => {
      if (unsaved.has("joysound")) return undefined;
      say("joysound", {
        text: "Switching Joysound's TV link to karafriends…",
        tone: "busy",
      });
      const result = await call("switchJoysoundLink", {});
      if (!result.ok) return { text: result.reason, tone: "problem" };
      return {
        text: result.note ? `Switched. ${result.note}` : "Switched.",
      };
    });

  const restart = () =>
    act("network", async () => {
      await call("restartApp", {});
      return { text: "Restarting…", tone: "busy" };
    });

  const exportConfig = () =>
    act("config", async () => {
      const { yaml } = await call("exportConfig", {});
      const saved = await deps.files.saveTextFile(
        "karafriends-config.yaml",
        yaml,
      );
      return saved ? { text: "Exported." } : null;
    });

  // The tabs whose settings it changed get a dot. Passwords show masked,
  // so a new one alone doesn't count. The app tests both logins before it
  // answers (up to 15 s), so it says so meanwhile; the Config file buttons
  // are off while it does, and saves wait for it.
  const importConfig = () =>
    act("config", async () => {
      const yaml = await deps.files.openTextFile();
      if (yaml === null) return null;
      say("config", {
        text: "Importing, and testing the logins in it…",
        tone: "busy",
      });
      const before = (await call("getSettings", {})).settings;
      const result = await call("importConfig", { yaml });
      const after = (await reload()).settings;
      deps.onImported(
        (Object.keys(SETTING_TABS) as (keyof SavedSettings)[])
          .filter((key) => before[key] !== after[key])
          .map((key) => SETTING_TABS[key]),
      );
      return result.ok
        ? { text: "Imported.", list: result.problems }
        : {
            text: "Not imported: nothing changed.",
            list: result.problems,
            tone: "problem",
          };
    });

  return {
    reload,
    act,
    save,
    saveNumber,
    testLogin,
    switchJoysoundLink,
    saveCount,
    failedSince,
    setAdminPassword,
    restart,
    exportConfig,
    importConfig,
  };
}
