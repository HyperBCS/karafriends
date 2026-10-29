// The settings as loaded, the messages under their sections, and what the
// fields and buttons do (actions.ts): for Settings, and for the setup
// screen, which shows some of the same sections.
import { useEffect, useRef, useState } from "react";

import { call } from "../../common/apiClient";
import {
  createSettingsActions,
  errorText,
  type Loaded,
  type Message,
  type Section,
} from "./actions";
import type { SettingsTab } from "./tabs";

export type Messages = Partial<Record<Section, Message | null>>;

export function useSettings(onImported?: (tabs: SettingsTab[]) => void) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Why getSettings failed, if it did (loaded.loadProblem is why
  // config.yaml didn't load, with the settings the app runs on).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Messages>({});
  const latestOnImported = useRef(onImported);
  latestOnImported.current = onImported;

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
      onImported: (tabs) => latestOnImported.current?.(tabs),
    }),
  );

  useEffect(() => {
    actions.reload().catch((err) => setLoadError(errorText(err)));
  }, []);

  return { loaded, loadError, messages, say, report, actions };
}
