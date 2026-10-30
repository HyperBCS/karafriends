import React, { useState } from "react";

import "../global";
import HostnameSetting, { CustomUrlSetting } from "../HostnameSetting";
import AdminPasswordSection from "./AdminPasswordSection";
import {
  LABELS,
  type Loaded,
  type Message,
  type Section,
  type SettingsActions,
} from "./actions";
import { Checkbox, SettingsSection, TextSetting } from "./controls";

// The port phones use, when it isn't the Port field's: under yarn dev, they
// load the remote from the Vite dev server, which passes /api on to the
// app's server (README, "yarn dev"). Never in a build.
const devServerPort = (savedPort: number): number | null => {
  const port = window.karafriends.remoconPort();
  return import.meta.env.DEV && port !== savedPort ? port : null;
};

// The address and port phones use, the queue's rules, and last the admin
// password.
export default function PartyTab(props: {
  loaded: Loaded;
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
  // The admin password being typed, kept while another tab is open.
  adminDraft: string;
  onAdminDraftChange: (draft: string) => void;
  hostname: string;
  onHostnameChange: (hostname: string) => void;
  customUrl: string | null;
  onCustomUrlChange: (url: string) => void;
}) {
  const { loaded, messages, actions } = props;
  // Custom URL… picked, before a URL is saved for it.
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || props.customUrl !== null;
  const { settings } = loaded;
  const devPort = devServerPort(settings.remoconPort);

  return (
    <>
      <SettingsSection title="Phones" message={messages.network}>
        <div className="settingsFields">
          <HostnameSetting
            hostname={props.hostname}
            custom={custom}
            onChange={(hostname) => {
              setCustomPicked(false);
              props.onHostnameChange(hostname);
            }}
            onPickCustom={() => setCustomPicked(true)}
          />
          <TextSetting
            label={LABELS.remoconPort}
            type="number"
            value={String(settings.remoconPort)}
            refused={messages.network?.refused === "remoconPort"}
            hint={
              devPort === null
                ? undefined
                : `Dev server: phones use port ${devPort}.`
            }
            onCommit={(value) =>
              actions.saveNumber("network", "remoconPort", value)
            }
          />
        </div>
        {custom ? (
          <CustomUrlSetting
            url={props.customUrl}
            onChange={props.onCustomUrlChange}
          />
        ) : null}
        {loaded.needsRestart ? (
          <div className="settingsRestart">
            <p>Restart to apply the new port.</p>
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
          hint="All phones get admin controls without a password."
          checked={settings.everyoneIsAdmin}
          onChange={(checked) =>
            actions.save("queue", { everyoneIsAdmin: checked })
          }
        />
        <div className="settingsFields">
          <TextSetting
            label={LABELS.paxSongQueueLimit}
            hint="0 for no limit."
            type="number"
            value={String(settings.paxSongQueueLimit)}
            refused={messages.queue?.refused === "paxSongQueueLimit"}
            onCommit={(value) =>
              actions.saveNumber("queue", "paxSongQueueLimit", value)
            }
          />
        </div>
      </SettingsSection>

      <AdminPasswordSection
        loaded={loaded}
        message={messages.admin}
        actions={actions}
        draft={props.adminDraft}
        onDraftChange={props.onAdminDraftChange}
      />
    </>
  );
}
