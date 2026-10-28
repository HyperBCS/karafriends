import React, { useEffect, useRef } from "react";

// The tabs down the left, in order.
export const SETTINGS_TABS = [
  "accounts",
  "party",
  "sound",
  "display",
  "advanced",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_NAMES: Record<SettingsTab, string> = {
  accounts: "Accounts",
  party: "Party",
  sound: "Sound",
  display: "Display",
  advanced: "Advanced",
};

// The place each key moves to, from the open tab's.
const TAB_KEYS: Record<string, (at: number) => number> = {
  ArrowUp: (at) => at - 1,
  ArrowDown: (at) => at + 1,
  Home: () => 0,
  End: () => SETTINGS_TABS.length - 1,
};

// The tabs down the left. Up and Down (Home and End too) open the one
// before or after, round the ends; only the open one is in the Tab order. A
// dot marks one with something to look at. Focused when it appears, so the
// keys work as soon as Settings opens.
export function SettingsTabs(props: {
  tab: SettingsTab;
  onChange: (tab: SettingsTab) => void;
  needsLook: (tab: SettingsTab) => boolean;
  tabId: (tab: SettingsTab) => string;
  panelId: string;
}) {
  const buttons = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const open = useRef(props.tab);
  useEffect(() => buttons.current.get(open.current)?.focus(), []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const move = TAB_KEYS[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const count = SETTINGS_TABS.length;
    const at = move(SETTINGS_TABS.indexOf(props.tab));
    const tab = SETTINGS_TABS[(at + count) % count];
    props.onChange(tab);
    buttons.current.get(tab)?.focus();
  };
  return (
    <div
      className="settingsTabs"
      role="tablist"
      aria-label="Sections"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
    >
      {SETTINGS_TABS.map((tab) => {
        const selected = tab === props.tab;
        const needsLook = !selected && props.needsLook(tab);
        return (
          <button
            key={tab}
            ref={(button) => {
              if (button) buttons.current.set(tab, button);
              else buttons.current.delete(tab);
            }}
            type="button"
            role="tab"
            id={props.tabId(tab)}
            className="settingsTab"
            aria-selected={selected}
            aria-controls={selected ? props.panelId : undefined}
            aria-description={needsLook ? "Needs a look" : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(tab)}
          >
            {TAB_NAMES[tab]}
            {needsLook ? (
              <span className="settingsTabDot" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
