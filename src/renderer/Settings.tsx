// The settings screen: the header, the tabs and the open tab's panel. Each
// tab is a file in settings/, with the parts they share in
// settings/controls.tsx and what the fields do in settings/actions.ts.
import React, { useEffect, useId, useState } from "react";

import { call } from "../common/apiClient";
import "./global";
import AccountsTab from "./settings/AccountsTab";
import {
  createSettingsActions,
  errorText,
  type Loaded,
  type Message,
  type Section,
  SECTION_TABS,
} from "./settings/actions";
import AdvancedTab, { useTools } from "./settings/AdvancedTab";
import DisplayTab, { type DisplayProps } from "./settings/DisplayTab";
import PartyTab from "./settings/PartyTab";
import SoundTab, { type SoundProps } from "./settings/SoundTab";
import { type SettingsTab, SettingsTabs } from "./settings/tabs";
import "./Settings.css";

export { SETTINGS_TABS, type SettingsTab } from "./settings/tabs";

// The settings screen, over everything, in tabs. Every field saves as the
// host leaves it; each section says under it what happened.
export default function Settings(
  props: {
    tab: SettingsTab;
    onTabChange: (tab: SettingsTab) => void;
    onClose: () => void;
    hostname: string;
    onHostnameChange: (hostname: string) => void;
  } & SoundProps &
    DisplayProps,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Why getSettings failed, if it did (loaded.loadProblem is why
  // config.yaml didn't load, with the settings the app runs on).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Partial<Record<Section, Message | null>>
  >({});
  // Tabs an import changed, until the host opens them.
  const [unseen, setUnseen] = useState<ReadonlySet<SettingsTab>>(new Set());
  const tabIds = useId();
  const tabId = (tab: SettingsTab) => `${tabIds}-${tab}`;
  const panelId = `${tabIds}-panel`;
  const [adminDraft, setAdminDraft] = useState("");

  const say = (section: Section, message: Message | null) =>
    setMessages((previous) => ({ ...previous, [section]: message }));

  // Why a device didn't open, under its section; null clears it.
  const report = (section: Section, problem: string | null) =>
    say(section, problem === null ? null : { text: problem, tone: "problem" });

  const [actions] = useState(() =>
    createSettingsActions({
      call,
      files: window.karafriends,
      say,
      setLoaded,
      onImported: (changed) =>
        setUnseen((tabs) => new Set([...tabs, ...changed])),
    }),
  );
  const tools = useTools(say);

  useEffect(() => {
    actions.reload().catch((err) => setLoadError(errorText(err)));
  }, []);

  const header = (
    <header className="settingsHeader">
      <h1>Settings</h1>
      <button type="button" className="kfButton" onClick={props.onClose}>
        Close
      </button>
    </header>
  );

  if (!loaded) {
    return (
      <div className="settings" role="dialog" aria-label="Settings">
        {header}
        <p className="settingsLoading">
          {loadError
            ? `Couldn't load the settings: ${loadError}`
            : "Loading settings…"}
        </p>
      </div>
    );
  }

  // A problem under one of its sections, a restart to do, or what an import
  // changed.
  const needsLook = (tab: SettingsTab) =>
    unseen.has(tab) ||
    (tab === "party" && loaded.needsRestart) ||
    Object.entries(messages).some(
      ([section, message]) =>
        message?.tone === "problem" && SECTION_TABS[section as Section] === tab,
    );

  const openTab = (tab: SettingsTab) => {
    props.onTabChange(tab);
    setUnseen((tabs) => new Set([...tabs].filter((seen) => seen !== tab)));
  };

  return (
    <div className="settings" role="dialog" aria-label="Settings">
      {header}
      <div className="settingsMain">
        <SettingsTabs
          tab={props.tab}
          onChange={openTab}
          needsLook={needsLook}
          tabId={tabId}
          panelId={panelId}
        />
        {/* A new tab starts at its top. */}
        <div
          key={props.tab}
          className="settingsPanel"
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(props.tab)}
        >
          {loaded.loadProblem ? (
            <p className="settingsBanner settingsMessage problem" role="alert">
              {loaded.loadProblem}
            </p>
          ) : null}
          {props.tab === "accounts" ? (
            <AccountsTab
              loaded={loaded}
              messages={messages}
              actions={actions}
            />
          ) : null}
          {props.tab === "party" ? (
            <PartyTab
              loaded={loaded}
              messages={messages}
              actions={actions}
              adminDraft={adminDraft}
              onAdminDraftChange={setAdminDraft}
              hostname={props.hostname}
              onHostnameChange={props.onHostnameChange}
            />
          ) : null}
          {props.tab === "sound" ? (
            <SoundTab {...props} messages={messages} report={report} />
          ) : null}
          {props.tab === "display" ? <DisplayTab {...props} /> : null}
          {props.tab === "advanced" ? (
            <AdvancedTab messages={messages} actions={actions} tools={tools} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
