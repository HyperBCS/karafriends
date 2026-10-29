// The setup screen: on a first start (no config.yaml at launch), over
// everything, three steps the host can go through or skip: the DAM and
// Joysound logins (or Import config, from another karaoke PC), the mics and
// speakers, and an admin password. Then the QR code.
import React, { useRef, useState } from "react";

import { call } from "../common/apiClient";
import "./global";
import AccountsTab from "./settings/AccountsTab";
import AdminPasswordSection from "./settings/AdminPasswordSection";
import { SettingsSection } from "./settings/controls";
import SoundTab, { type SoundProps } from "./settings/SoundTab";
import { useSettings } from "./settings/useSettings";
import ToolsDownloadNote from "./ToolsDownloadNote";
import "./Settings.css";
import "./Setup.css";

const STEPS = [
  { id: "logins", name: "Logins" },
  { id: "sound", name: "Mics and speakers" },
  { id: "admin", name: "Admin password" },
] as const;

export default function Setup(props: SoundProps & { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [adminDraft, setAdminDraft] = useState("");
  const { loaded, loadError, messages, report, actions } = useSettings();
  // Leaving a step saves the field being edited, as leaving the field does,
  // and the step stays if it didn't save (see Settings' Close). A pointer
  // down on a button blurs the field before the click, so the saves are
  // counted from there.
  const leavingFrom = useRef<number | null>(null);
  const markLeaving = () => (leavingFrom.current = actions.saveCount());
  const leave = async (then: () => void) => {
    const from = leavingFrom.current ?? actions.saveCount();
    leavingFrom.current = null;
    (document.activeElement as HTMLElement | null)?.blur();
    if (!(await actions.failedSince(from))) then();
  };
  const done = () =>
    leave(() => {
      call("finishSetup", {}).catch((err) =>
        console.error("Couldn't finish the setup:", err),
      );
      props.onDone();
    });

  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  let content: React.ReactNode;
  if (!loaded) {
    content = (
      <p className="settingsLoading">
        {loadError
          ? `Couldn't load the settings: ${loadError}`
          : "Loading settings…"}
      </p>
    );
  } else if (current.id === "logins") {
    content = (
      <>
        <p className="settingsBanner">
          Sign in to DAM and Joysound so guests can find and sing their songs.
          Each login is checked as you enter it. YouTube and Niconico work
          without one.
        </p>
        <SettingsSection
          title="From another karaoke PC?"
          message={messages.config}
        >
          <div className="settingsActions">
            <button
              type="button"
              className="kfButton"
              onPointerDown={markLeaving}
              onClick={() => void actions.importConfig()}
            >
              Import config
            </button>
            <p className="settingsHint">
              A file from Export config (Settings › Advanced) brings its logins
              and settings here.
            </p>
          </div>
        </SettingsSection>
        <AccountsTab loaded={loaded} messages={messages} actions={actions} />
      </>
    );
  } else if (current.id === "sound") {
    content = <SoundTab {...props} messages={messages} report={report} />;
  } else {
    content = (
      <>
        <p className="settingsBanner">
          An admin password lets phones sign in to skip, reorder and remove
          anyone's songs. Without one, only this screen can.
        </p>
        <AdminPasswordSection
          loaded={loaded}
          message={messages.admin}
          actions={actions}
          draft={adminDraft}
          onDraftChange={setAdminDraft}
        />
      </>
    );
  }

  return (
    <div className="settings setup" role="dialog" aria-label="Setup">
      <header className="settingsHeader">
        <div className="setupTitle">
          <h1>Welcome to karafriends</h1>
          <ol className="setupSteps" aria-label="Steps">
            {STEPS.map((each, index) => (
              <li
                key={each.id}
                className="setupStep"
                aria-current={index === step ? "step" : undefined}
              >
                <span className="setupStepNumber" aria-hidden="true">
                  {index + 1}
                </span>
                {each.name}
              </li>
            ))}
          </ol>
        </div>
        <button
          type="button"
          className="kfButton"
          onPointerDown={markLeaving}
          onClick={() => void done()}
        >
          Skip setup
        </button>
      </header>
      {/* A new step starts at its top. */}
      <div key={current.id} className="setupPanel">
        {content}
      </div>
      <footer className="setupFooter">
        <ToolsDownloadNote />
        <div className="setupNav">
          {step > 0 ? (
            <button
              type="button"
              className="kfButton"
              onPointerDown={markLeaving}
              onClick={() => void leave(() => setStep(step - 1))}
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="kfButton primary"
            onPointerDown={markLeaving}
            onClick={() =>
              void (last ? done() : leave(() => setStep(step + 1)))
            }
          >
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </footer>
    </div>
  );
}
