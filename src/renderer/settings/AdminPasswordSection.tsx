import React from "react";

import type { Loaded, Message, SettingsActions } from "./actions";
import { Hint, SettingsSection } from "./controls";

// The admin password phones sign in with: set, changed or cleared. The
// draft is kept by the screen it's on (Settings keeps it while another tab
// is open).
export default function AdminPasswordSection(props: {
  loaded: Loaded;
  message: Message | null | undefined;
  actions: SettingsActions;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  const { settings } = props.loaded;
  const setAdminPassword = (password: string) =>
    props.actions.setAdminPassword(password, () => props.onDraftChange(""));
  return (
    <SettingsSection title="Admin password" message={props.message}>
      <form
        className="settingsInline"
        onSubmit={(event) => {
          event.preventDefault();
          if (props.draft) setAdminPassword(props.draft);
        }}
      >
        <label className="kfLabel">
          {settings.adminPasswordSet ? "New password" : "Password"}
          <input
            className="kfField"
            type="password"
            autoComplete="new-password"
            value={props.draft}
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="kfButton primary"
          disabled={props.draft === ""}
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
  );
}
