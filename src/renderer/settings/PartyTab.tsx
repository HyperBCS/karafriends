import React from "react";

import "../global";
import HostnameSetting from "../HostnameSetting";
import {
  LABELS,
  type Loaded,
  type Message,
  type Section,
  type SettingsActions,
} from "./actions";
import { Checkbox, Hint, SettingsSection, TextSetting } from "./controls";

// The port phones use, when it isn't the Port field's: under yarn dev, they
// load the remote from the Vite dev server, which passes /api on to the
// app's server (README, "yarn dev"). Never in a build.
const devServerPort = (savedPort: number): number | null => {
  const port = window.karafriends.remoconPort();
  return import.meta.env.DEV && port !== savedPort ? port : null;
};

// The admin password, the queue's rules, and the address and port phones
// use.
export default function PartyTab(props: {
  loaded: Loaded;
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
  // The admin password being typed, kept while another tab is open.
  adminDraft: string;
  onAdminDraftChange: (draft: string) => void;
  hostname: string;
  onHostnameChange: (hostname: string) => void;
}) {
  const { loaded, messages, actions } = props;
  const { settings } = loaded;
  const setAdminPassword = (password: string) =>
    actions.setAdminPassword(password, () => props.onAdminDraftChange(""));
  const devPort = devServerPort(settings.remoconPort);

  return (
    <>
      <SettingsSection title="Admin password" message={messages.admin}>
        <form
          className="settingsInline"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.adminDraft) setAdminPassword(props.adminDraft);
          }}
        >
          <label className="kfLabel">
            {settings.adminPasswordSet ? "New password" : "Password"}
            <input
              className="kfField"
              type="password"
              autoComplete="new-password"
              value={props.adminDraft}
              onChange={(event) => props.onAdminDraftChange(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="kfButton primary"
            disabled={props.adminDraft === ""}
          >
            {settings.adminPasswordSet ? "Change password" : "Set password"}
          </button>
          {settings.adminPasswordSet ? (
            <button
              type="button"
              className="kfButton"
              onClick={() => setAdminPassword("")}
            >
              Clear
            </button>
          ) : null}
        </form>
        <Hint>
          {settings.adminPasswordSet
            ? "Admins can reorder, skip and remove any song."
            : "Set one to let phones sign in as admins."}
        </Hint>
      </SettingsSection>

      <SettingsSection title="Queue" message={messages.queue}>
        <Checkbox
          label="Supervised mode"
          hint="Only the singer or an admin can pause, skip or remove a song."
          checked={settings.supervisedMode}
          onChange={(checked) =>
            actions.save("queue", { supervisedMode: checked })
          }
        />
        <Checkbox
          label="Everyone is an admin"
          hint="Every phone gets the admin controls, no password needed."
          checked={settings.everyoneIsAdmin}
          onChange={(checked) =>
            actions.save("queue", { everyoneIsAdmin: checked })
          }
        />
        <div className="settingsFields">
          <TextSetting
            label={LABELS.paxSongQueueLimit}
            hint="Queued at once. 0 means no limit."
            type="number"
            value={String(settings.paxSongQueueLimit)}
            onCommit={(value) =>
              actions.saveNumber("queue", "paxSongQueueLimit", value)
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Phones" message={messages.network}>
        <div className="settingsFields">
          <HostnameSetting
            hostname={props.hostname}
            onChange={props.onHostnameChange}
          />
          <TextSetting
            label={LABELS.remoconPort}
            type="number"
            value={String(settings.remoconPort)}
            hint={
              devPort === null
                ? undefined
                : `Running with yarn dev: phones use the dev server's port, ${devPort}.`
            }
            onCommit={(value) =>
              actions.saveNumber("network", "remoconPort", value)
            }
          />
        </div>
        <Hint>The QR code sends phones to this address.</Hint>
        {loaded.needsRestart ? (
          <div className="settingsRestart">
            <p>Restart karafriends to use the new port.</p>
            <button
              type="button"
              className="kfButton primary"
              onClick={actions.restart}
            >
              Restart
            </button>
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
}
