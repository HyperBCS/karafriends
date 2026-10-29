// The settings methods: the display's settings screen reads and changes
// config.yaml, tests the DAM and Joysound logins, and exports and imports
// the whole file, and shows and updates ffmpeg and yt-dlp. Display only:
// server.ts refuses them to phones (DISPLAY_ONLY_METHODS), and each handler
// checks again.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { parse, stringify } from "yaml";

import { hashAdminPassword, newAdminSalt } from "../common/adminPassword";
import {
  MASKED_PASSWORD,
  type LoginService,
  type Settings,
  type TestLoginResult,
  type ToolsStatus,
} from "../common/api";
import {
  clearPlaceholders,
  CONFIG_KEYS,
  configProblems,
  dropObsoleteKeys,
  hasLogin,
  isConfigKey,
  RESTART_KEYS,
  type KarafriendsConfig,
} from "../common/configSchema";
import type { ConfigStore } from "../common/configStore";
import { ApiError, type ApiHandlers, type Caller } from "./api";
import { type LoginNote, LoginWarning } from "./credentials";
import { HttpStatusError } from "./http";
import { TimeoutError, withTimeout } from "./timeout";

export const SETTINGS_METHODS = [
  "getSettings",
  "setSettings",
  "setAdminPassword",
  "testLogin",
  "switchJoysoundLink",
  "exportConfig",
  "importConfig",
  "restartApp",
  "getToolsStatus",
  "updateTools",
] as const;

export type SettingsMethod = (typeof SETTINGS_METHODS)[number];

const PASSWORD_KEYS = ["damPassword", "joysoundPassword"] as const;

// What setSettings may change: everything but the admin password's hash and
// salt (setAdminPassword).
export const SETTABLE_KEYS = CONFIG_KEYS.filter(
  (key) => key !== "adminPasswordHash" && key !== "adminPasswordSalt",
);

const LOGIN_TIMEOUT_MS = 15_000;
// Signing in, switching and checking the link: a few more requests.
const SWITCH_TIMEOUT_MS = 30_000;

const SERVICE_NAMES: Record<LoginService, string> = {
  dam: "DAM",
  joysound: "Joysound",
};

export interface SettingsDeps {
  store: Pick<ConfigStore, "saved" | "atLaunch" | "update" | "loadProblem">;
  // A fresh login, not the clients' shared one. Resolves on success, to a
  // sentence for the host if there's more to say (how karafriends' link to
  // the Joysound account stands). It changes nothing the clients use:
  // Joysound's test links nothing.
  logins: Record<
    LoginService,
    (username: string, password: string) => Promise<LoginNote | void>
  >;
  // Links karafriends to the Joysound account as its TV app, unlinking any
  // other (joysoundLink.ts's switchLink), and has the clients check their
  // link again. Resolves to a sentence for the host.
  switchJoysoundLink(email: string, password: string): Promise<string>;
  // app.relaunch() and app.exit(0).
  restart(): void;
  // externalResources.ts's, with the live state's problem.
  tools: {
    status(): ToolsStatus;
    // Downloads the tools again; then the problem is cleared.
    update(): Promise<void>;
  };
}

// Why a login failed, in a sentence for the host.
export function loginFailureReason(
  service: LoginService,
  err: unknown,
  timeoutMs = LOGIN_TIMEOUT_MS,
): string {
  const name = SERVICE_NAMES[service];
  if (err instanceof LoginWarning) return err.message;
  if (err instanceof TimeoutError) {
    return (
      `${name} didn't answer within ${timeoutMs / 1000} seconds. ` +
      "Check this computer's internet connection and VPN."
    );
  }
  if (err instanceof HttpStatusError && err.status === 403) {
    return (
      `${name} answered 403: this usually means no Japanese IP address. ` +
      "Connect through a VPN to Japan."
    );
  }
  return `Couldn't sign in to ${name}: ${(err as Error)?.message ?? String(err)}`;
}

export function createSettingsHandlers(
  deps: SettingsDeps,
): Pick<ApiHandlers, SettingsMethod> {
  const { store } = deps;

  const requireDisplay = (caller: Caller) => {
    if (!caller.isDisplay) {
      throw new ApiError(403, "Only the display can see or change settings");
    }
  };

  const needsRestart = () => {
    const saved = store.saved();
    return RESTART_KEYS.some((key) => saved[key] !== store.atLaunch[key]);
  };

  // Checks values, then saves them; or says what's wrong.
  const save = (values: Record<string, unknown>): string[] => {
    const problems = configProblems(values);
    if (problems.length > 0) return problems;
    try {
      store.update(values as Partial<KarafriendsConfig>);
      return [];
    } catch (err) {
      console.error("Couldn't save the settings:", err);
      return [`Couldn't save config.yaml: ${(err as Error).message}`];
    }
  };

  const testLogin = async (service: LoginService): Promise<TestLoginResult> => {
    const saved = store.saved();
    const { username, password } =
      service === "dam"
        ? { username: saved.damUsername, password: saved.damPassword }
        : { username: saved.joysoundEmail, password: saved.joysoundPassword };
    if (!hasLogin(saved, service)) {
      const what = service === "dam" ? "username" : "email";
      return {
        ok: false,
        reason: `No ${SERVICE_NAMES[service]} login is set: enter the ${what} and password first.`,
      };
    }
    try {
      const note = await withTimeout(
        deps.logins[service](username, password),
        LOGIN_TIMEOUT_MS,
        `${SERVICE_NAMES[service]}'s login`,
      );
      if (!note || note.note === "") return { ok: true };
      return note.canSwitchLink
        ? { ok: true, note: note.note, canSwitchLink: true }
        : { ok: true, note: note.note };
    } catch (err) {
      console.warn(
        `testLogin: ${SERVICE_NAMES[service]} failed:`,
        (err as Error)?.message ?? err,
      );
      return err instanceof LoginWarning && err.canSwitchLink
        ? {
            ok: false,
            reason: loginFailureReason(service, err),
            canSwitchLink: true,
          }
        : { ok: false, reason: loginFailureReason(service, err) };
    }
  };

  return {
    async getSettings(_input, caller) {
      requireDisplay(caller);
      const saved = store.saved();
      const settings = Object.fromEntries(
        SETTABLE_KEYS.map((key) => [key, saved[key]]),
      ) as Omit<Settings, "adminPasswordSet">;
      for (const key of PASSWORD_KEYS) {
        if (saved[key] !== "") settings[key] = MASKED_PASSWORD;
      }
      return {
        settings: {
          ...settings,
          adminPasswordSet: saved.adminPasswordHash !== "",
        },
        isFirstRun: !hasLogin(saved, "dam") && !hasLogin(saved, "joysound"),
        needsRestart: needsRestart(),
        loadProblem: store.loadProblem,
      };
    },

    async setSettings({ settings }, caller) {
      requireDisplay(caller);
      const values: Record<string, unknown> = { ...settings };
      for (const key of PASSWORD_KEYS) {
        if (values[key] === MASKED_PASSWORD) delete values[key];
      }
      const problems = save(values);
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, needsRestart: needsRestart() };
    },

    // An empty password means none: no phone can become an admin. A new
    // salt every time, so even the same password changes the hash, which
    // signs every phone out (endSessionsOnPasswordChange).
    async setAdminPassword({ password }, caller) {
      requireDisplay(caller);
      const salt = newAdminSalt();
      store.update({
        adminPasswordSalt: salt,
        adminPasswordHash:
          password === "" ? "" : hashAdminPassword(password, salt),
      });
      return {};
    },

    async testLogin({ service }, caller) {
      requireDisplay(caller);
      return testLogin(service);
    },

    async switchJoysoundLink(_input, caller) {
      requireDisplay(caller);
      const saved = store.saved();
      if (!hasLogin(saved, "joysound")) {
        return {
          ok: false,
          reason:
            "No Joysound login is set: enter the email and password first.",
        };
      }
      try {
        const note = await withTimeout(
          deps.switchJoysoundLink(saved.joysoundEmail, saved.joysoundPassword),
          SWITCH_TIMEOUT_MS,
          "Joysound's TV link",
        );
        return { ok: true, note };
      } catch (err) {
        console.warn(
          "switchJoysoundLink failed:",
          (err as Error)?.message ?? err,
        );
        return {
          ok: false,
          reason: loginFailureReason("joysound", err, SWITCH_TIMEOUT_MS),
        };
      }
    },

    async exportConfig(_input, caller) {
      requireDisplay(caller);
      return {
        yaml: `karafriendsConfigVersion: 1\n${stringify(store.saved())}`,
      };
    },

    async importConfig({ yaml }, caller) {
      requireDisplay(caller);
      let parsed: unknown;
      try {
        // No warnings: the parser prints them with the line, as below.
        parsed = parse(yaml, { logLevel: "error" });
      } catch (err) {
        // Not the parser's message: it quotes the line, which may hold a
        // password.
        const line = (err as { linePos?: { line: number }[] }).linePos?.[0]
          ?.line;
        return {
          ok: false,
          problems: [
            `The file isn't valid YAML${line ? ` (line ${line})` : ""}. ` +
              "Pick a file from Export config, or a config.yaml.",
          ],
        };
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {
          ok: false,
          problems: [
            "The file has no settings in it. Pick a file from Export config, or a config.yaml.",
          ],
        };
      }

      const values: Record<string, unknown> = { ...parsed };
      delete values.karafriendsConfigVersion;
      // An old config.yaml's YOUR_PASSWORD_HERE and the like mean nothing set.
      clearPlaceholders(values);
      const notes = dropObsoleteKeys(values).map(
        ({ keys, why }) => `Dropped ${keys}: ${why}`,
      );
      for (const key of Object.keys(values)) {
        if (!isConfigKey(key)) {
          notes.push(`Dropped ${key}: karafriends has no such setting.`);
          delete values[key];
        }
      }

      const before = store.saved();
      const problems = save(values);
      if (problems.length > 0) return { ok: false, problems };
      const after = store.saved();
      if (
        after.adminPasswordHash !== before.adminPasswordHash ||
        after.adminPasswordSalt !== before.adminPasswordSalt
      ) {
        // services.ts ends their sessions.
        notes.push("Phones signed in as admins must sign in again.");
      }

      const results = await Promise.all(
        (["dam", "joysound"] as const).map(async (service) => {
          const result = await testLogin(service);
          // Each reason names the service.
          if (!result.ok) return result.reason;
          const works = `${SERVICE_NAMES[service]} login works.`;
          return result.note ? `${works} ${result.note}` : works;
        }),
      );
      return { ok: true, problems: [...notes, ...results] };
    },

    async restartApp(_input, caller) {
      requireDisplay(caller);
      // After the answer has gone out.
      setTimeout(deps.restart, 200);
      return {};
    },

    async getToolsStatus(_input, caller) {
      requireDisplay(caller);
      return deps.tools.status();
    },

    async updateTools(_input, caller) {
      requireDisplay(caller);
      try {
        await deps.tools.update();
        return { ok: true };
      } catch (err) {
        console.error("Updating the tools failed:", err);
        return {
          ok: false,
          reason: `Couldn't update the tools: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
  };
}
