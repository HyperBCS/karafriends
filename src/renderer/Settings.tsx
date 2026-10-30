// The settings screen: the header, the tabs and the open tab's panel. Each
// tab is a file in settings/, with the parts they share in
// settings/controls.tsx and what the fields do in settings/actions.ts.
import React, { useEffect, useId, useRef, useState } from "react";

import "./global";
import AccountsTab from "./settings/AccountsTab";
import { type Section, SECTION_TABS } from "./settings/actions";
import AdvancedTab, { useTools } from "./settings/AdvancedTab";
import DisplayTab, { type DisplayProps } from "./settings/DisplayTab";
import PartyTab from "./settings/PartyTab";
import SoundTab, { type SoundProps } from "./settings/SoundTab";
import { type SettingsTab, SettingsTabs } from "./settings/tabs";
import { useSettings } from "./settings/useSettings";
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
    customUrl: string | null;
    onCustomUrlChange: (url: string) => void;
  } & SoundProps &
    DisplayProps,
) {
  // Tabs an import changed, until the host opens them.
  const [unseen, setUnseen] = useState<ReadonlySet<SettingsTab>>(new Set());
  const { loaded, loadError, messages, say, report, actions } = useSettings(
    (changed) => setUnseen((tabs) => new Set([...tabs, ...changed])),
  );
  const tabIds = useId();
  const tabId = (tab: SettingsTab) => `${tabIds}-${tab}`;
  const panelId = `${tabIds}-panel`;
  const [adminDraft, setAdminDraft] = useState("");

  const tools = useTools(say);

  // Leaving Settings saves the field being edited, as leaving the field
  // does: Close and Escape wait for that save, and Settings stays open,
  // saying why under the field, if it didn't save. A pointer down on Close
  // blurs the field before the click, so the saves are counted from there.
  const closingFrom = useRef<number | null>(null);
  const close = async () => {
    const from = closingFrom.current ?? actions.saveCount();
    closingFrom.current = null;
    (document.activeElement as HTMLElement | null)?.blur();
    if (!(await actions.failedSince(from))) props.onClose();
  };
  const latestClose = useRef(close);
  latestClose.current = close;
  // Escape closes it, from a field too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void latestClose.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const header = (
    <header className="settingsHeader">
      <h1>Settings</h1>
      <button
        type="button"
        className="kfButton"
        onPointerDown={() => (closingFrom.current = actions.saveCount())}
        onClick={close}
      >
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
            ? `Couldn't load settings: ${loadError}`
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
        >
          {/* Looks like a tab, opens no panel: the main process asks, then
              quits. Not in the tabs' keys, so passing over it, or Settings
              opening where it was left, never asks. */}
          <button
            type="button"
            className="settingsTab"
            onClick={() => {
              window.karafriends
                .quit()
                .catch((err) => console.error("Couldn't quit:", err));
            }}
          >
            Quit
          </button>
        </SettingsTabs>
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
              customUrl={props.customUrl}
              onCustomUrlChange={props.onCustomUrlChange}
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
