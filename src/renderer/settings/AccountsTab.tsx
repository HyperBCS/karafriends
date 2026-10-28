import React from "react";

import type { LoginService } from "../../common/api";
import {
  type Loaded,
  type Message,
  type Section,
  SERVICE_NAMES,
  type SettingsActions,
} from "./actions";
import { Checkbox, SettingsSection, TextSetting } from "./controls";

// The DAM and Joysound logins, each with a Test login button; on the first
// launch, a note over them.
export default function AccountsTab(props: {
  loaded: Loaded;
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
}) {
  const { settings } = props.loaded;
  const { save, testLogin } = props.actions;

  const loginSection = (service: LoginService) => {
    const [userKey, passKey, userLabel] =
      service === "dam"
        ? (["damUsername", "damPassword", "Username"] as const)
        : (["joysoundEmail", "joysoundPassword", "Email"] as const);
    const message = props.messages[service];
    return (
      <SettingsSection
        title={`${SERVICE_NAMES[service]} login`}
        message={message}
      >
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
        </div>
      </SettingsSection>
    );
  };

  return (
    <>
      {props.loaded.isFirstRun ? (
        <p className="settingsBanner">
          Add your DAM or Joysound login to search their catalogs. YouTube works
          without one.
        </p>
      ) : null}
      {loginSection("dam")}
      {loginSection("joysound")}
    </>
  );
}
