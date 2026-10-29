import React from "react";

import type { CatalogStatus, LoginService } from "../../common/api";
import { useLiveState } from "../../common/apiClient";
import {
  type Loaded,
  type Message,
  type Section,
  SERVICE_NAMES,
  type SettingsActions,
} from "./actions";
import { Checkbox, SettingsSection, TextSetting } from "./controls";

// How a catalog stands (the live state's catalogs), in a line for the
// host, and its tone: on, a problem, or neither.
export function catalogLine(
  service: LoginService,
  status: CatalogStatus,
): { text: string; tone: "on" | "problem" | "" } {
  const name = SERVICE_NAMES[service];
  switch (status.state) {
    case "disabled":
      return {
        text: `Turned off: guests don't see ${name} songs.`,
        tone: "",
      };
    case "off":
      return {
        text: `Off: guests can't find ${name} songs until a login is set.`,
        tone: "",
      };
    case "checking":
      return { text: `Signing in to ${name}…`, tone: "" };
    case "on":
      return {
        text: `On: guests can find and sing ${name} songs.`,
        tone: "on",
      };
    case "unreachable":
      return {
        text: `${status.reason} Trying again by itself.`,
        tone: "problem",
      };
    case "failed":
      return { text: status.reason, tone: "problem" };
  }
}

// The line itself, from the live state.
export function CatalogStatusLine(props: { service: LoginService }) {
  const status = useLiveState((state) => state?.catalogs[props.service]);
  if (!status) return null;
  const { text, tone } = catalogLine(props.service, status);
  return (
    <p className={`settingsCatalog ${tone}`} aria-live="polite">
      <span className="settingsCatalogDot" aria-hidden="true" />
      {text}
    </p>
  );
}

// The DAM and Joysound logins, each with a switch for its catalog, how it
// stands, and a Test login button.
export default function AccountsTab(props: {
  loaded: Loaded;
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
}) {
  const { settings } = props.loaded;
  const { save, testLogin, switchJoysoundLink } = props.actions;
  // Another TV app holds Joysound's link, as karafriends found when it
  // signed in.
  const linkTaken = useLiveState((state) => {
    const status = state?.catalogs.joysound;
    return status?.state === "failed" && status.canSwitchLink === true;
  });

  const loginSection = (service: LoginService) => {
    const [enabledKey, userKey, passKey, userLabel] =
      service === "dam"
        ? (["damEnabled", "damUsername", "damPassword", "Username"] as const)
        : ([
            "joysoundEnabled",
            "joysoundEmail",
            "joysoundPassword",
            "Email",
          ] as const);
    const message = props.messages[service];
    const offersSwitch =
      service === "joysound" && (message?.offersSwitch || linkTaken);
    return (
      <SettingsSection
        title={`${SERVICE_NAMES[service]} login`}
        message={message}
      >
        {/* The host can turn a catalog off whatever its login: it isn't
            signed in to, and phones don't show it. */}
        <Checkbox
          label={`Use ${SERVICE_NAMES[service]}`}
          checked={settings[enabledKey]}
          onChange={(checked) => save(service, { [enabledKey]: checked })}
        />
        <CatalogStatusLine service={service} />
        <div className="settingsFields">
          <TextSetting
            label={userLabel}
            value={settings[userKey]}
            refused={message?.refused === userKey}
            onCommit={(value) => save(service, { [userKey]: value })}
          />
          <TextSetting
            label="Password"
            type="password"
            value={settings[passKey]}
            refused={message?.refused === passKey}
            onCommit={(value) => save(service, { [passKey]: value })}
          />
        </div>
        {service === "dam" ? (
          <Checkbox
            label="Stream at a low bitrate"
            checked={settings.useLowBitrateUrl}
            onChange={(checked) => save("dam", { useLowBitrateUrl: checked })}
          />
        ) : null}
        <div className="settingsActions">
          <button
            type="button"
            className="kfButton"
            onClick={() => testLogin(service)}
          >
            Test login
          </button>
          {offersSwitch ? (
            // Joysound links one TV app to an account at a time: this
            // unlinks the other one, so only when the host asks.
            <button
              type="button"
              className="kfButton"
              onClick={() => switchJoysoundLink()}
            >
              Switch the TV link to karafriends
            </button>
          ) : null}
        </div>
      </SettingsSection>
    );
  };

  return (
    <>
      {loginSection("dam")}
      {loginSection("joysound")}
    </>
  );
}
