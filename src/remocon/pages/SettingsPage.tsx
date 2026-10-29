import React, { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  adminSignIn,
  adminSignOut,
  ApiCallError,
  call,
  useIsAdmin,
  useLiveState,
} from "../../common/apiClient";
import useLiveSetter from "../../common/hooks/useLiveSetter";
import { GATE_MAX_DB, GATE_OFF_DB } from "../../common/micGate";
import {
  LyricsModeChoice,
  saveLyricsMode,
  savedLyricsMode,
} from "../components/QueueButtons";
import {
  Button,
  InlineError,
  SegmentedControl,
  TextField,
} from "../components/ui";
import useReadings, { saveReadings } from "../hooks/useReadings";
import useUserIdentity, { saveNickname } from "../hooks/useUserIdentity";
import { LANGUAGES, t, useLanguage, type Language } from "../i18n";
import {
  READINGS_MODES,
  type MicInfo,
  type ReadingsMode,
} from "../../common/api";
import { currentTheme, saveTheme, THEMES, type Theme } from "../theme";
import * as styles from "./SettingsPage.module.scss";

// What to tell a guest whose sign-in failed.
function signInError(err: unknown): string {
  if (err instanceof ApiCallError) {
    if (err.status === 403) return t("settings.wrongPassword");
    if (err.status === 409) return t("settings.noPassword");
    if (err.status === 429) return t("settings.tooManyTries");
    return t("settings.signInFailed", { reason: err.message });
  }
  // fetch() itself failed: no connection.
  return t("common.offline");
}

// A few settings under one heading, in a card.
const Group = ({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) => {
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id}>
      <h2 id={id} className={styles.heading}>
        {heading}
      </h2>
      <div className={styles.settings}>{children}</div>
    </section>
  );
};

const Nickname = ({ firstVisit }: { firstVisit: boolean }) => {
  const navigate = useNavigate();
  const { nickname } = useUserIdentity();
  const [draft, setDraft] = useState(nickname ?? "");
  const trimmed = draft.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (trimmed === "") return;
    saveNickname(trimmed);
    setDraft(trimmed);
    // A new phone goes on to search once it has a name.
    if (firstVisit) navigate("/", { replace: true });
  };

  return (
    <form className={styles.setting} onSubmit={submit}>
      {firstVisit && <p className={styles.text}>{t("settings.firstVisit")}</p>}
      <TextField
        label={t("settings.nickname")}
        value={draft}
        onValueChange={setDraft}
        autoFocus={firstVisit}
        autoComplete="nickname"
        enterKeyHint="done"
        maxLength={32}
      />
      <Button
        type="submit"
        variant={firstVisit ? "primary" : "secondary"}
        disabled={trimmed === "" || trimmed === nickname}
      >
        {t(firstVisit ? "settings.start" : "settings.saveNickname")}
      </Button>
    </form>
  );
};

const LanguagePicker = () => {
  const { language, setLanguage } = useLanguage();
  return (
    <SegmentedControl<Language>
      label={t("language.label")}
      choices={LANGUAGES.map((id) => ({ id, label: t(`language.${id}`) }))}
      selected={language}
      onSelect={setLanguage}
    />
  );
};

// How this phone shows song titles and artists: as written, or in their
// kana reading or in romaji instead (where DAM gives a reading). Songs it
// queues show that way on the TV too.
const ReadingsPicker = () => {
  const readings = useReadings();
  return (
    <SegmentedControl<ReadingsMode>
      label={t("readings.label")}
      choices={READINGS_MODES.map((id) => ({
        id,
        label: t(`readings.${id}`),
      }))}
      selected={readings}
      onSelect={saveReadings}
    />
  );
};

// Light, dark, or as the phone is set (theme.ts).
const ThemePicker = () => {
  const [theme, setTheme] = useState(currentTheme);
  return (
    <SegmentedControl<Theme>
      label={t("theme.label")}
      choices={THEMES.map((id) => ({ id, label: t(`theme.${id}`) }))}
      selected={theme}
      onSelect={(next) => {
        saveTheme(next);
        setTheme(next);
      }}
    />
  );
};

interface LevelSliderProps {
  label: string;
  // The slider's accessible name: the label without the value, or one that
  // says whose when the label alone doesn't.
  name?: string;
  // What the value is multiplied by to show as a percent.
  scale?: number;
  // The value as the label shows it, in place of a percent.
  format?: (value: number) => string;
  min: number;
  max: number;
  step: number;
  value: number;
  onSend: (value: number) => void;
}

// An admin's level slider. While the thumb is dragged it moves here only;
// letting go (the input's change event, which a key press also fires) sends
// the level once, so the echo of an earlier step can't pull the thumb back
// or settle on a stale level. A drag that ends where it started fires no
// change, so letting go there lets the thumb follow the live level again.
// The label shows the level in percent, as the display does.
const LevelSlider = ({
  label,
  name = label,
  scale = 1,
  format = (value) => `${Math.round(value * scale)}%`,
  min,
  max,
  step,
  value,
  onSend,
}: LevelSliderProps) => {
  const [held, setHeld] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The value when the drag began. Only a drag back to it is let go of on
  // pointerup: any other comes with a change after it, which needs the
  // input's value as dragged.
  const start = useRef("");
  // React's onChange is the input event, which comes with every step.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const send = () => {
      onSend(Number(el.value));
      setHeld(null);
    };
    el.addEventListener("change", send);
    return () => el.removeEventListener("change", send);
  });

  const shown = held ?? value;

  return (
    <label className={styles.slider}>
      {`${label} ${format(shown)}`}
      <input
        ref={input}
        aria-label={name}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setHeld(Number(e.target.value))}
        onPointerDown={(e) => (start.current = e.currentTarget.value)}
        onPointerUp={(e) => {
          if (e.currentTarget.value === start.current) setHeld(null);
        }}
        onPointerCancel={() => setHeld(null)}
        onBlur={() => setHeld(null)}
      />
    </label>
  );
};

// How loud Joysound's guide plays (its melody, or the voice of a song
// queued with guide vocal), whatever is playing.
const GuideMelodySlider = () => {
  const [guideMelodyLevel, setGuideMelodyLevel] = useLiveSetter(
    useLiveState((state) => state?.guideMelodyLevel ?? 0),
    (level: number) => call("setGuideMelodyLevel", { level }),
    "change the guide melody level",
  );
  return (
    <div className={styles.setting}>
      <LevelSlider
        label={t("guideMelody.label")}
        scale={100}
        min={0}
        max={1}
        step={0.1}
        value={guideMelodyLevel}
        onSend={setGuideMelodyLevel}
      />
      <p className={styles.help}>{t("guideMelody.help")}</p>
    </div>
  );
};

// The song's volume on the display, 0 to 100 %.
const SongVolumeSlider = () => {
  const [volume, setVolume] = useLiveSetter(
    useLiveState((state) => state?.songVolume ?? 100),
    (volume: number) => call("setSongVolume", { volume }),
    "change the song volume",
  );
  return (
    <LevelSlider
      label={t("songVolume.label")}
      min={0}
      max={100}
      step={5}
      value={volume}
      onSend={setVolume}
    />
  );
};

// The noise gate as its slider says it: "Off", or "−45 dB".
const gateText = (db: number) =>
  db <= GATE_OFF_DB ? t("mics.gateOff") : `−${Math.abs(db)} dB`;

// The range of each of a mic's levels: gain and echo in percent, the noise
// gate in dB.
const MIC_LEVELS = {
  gain: { min: 0, max: 200 },
  echo: { min: 0, max: 100 },
  gate: { min: GATE_OFF_DB, max: GATE_MAX_DB },
} as const;

// One of a mic's levels: gain (0 to 200 %), echo (0 to 100 %) or its noise
// gate (Off, then −59 to −20 dB).
const MicLevelSlider = ({
  mic,
  level,
}: {
  mic: MicInfo;
  level: keyof typeof MIC_LEVELS;
}) => {
  const [value, setValue] = useLiveSetter(
    mic[level],
    (value: number) => call("setMicLevels", { id: mic.id, [level]: value }),
    `change the mic's ${level}`,
  );
  return (
    <LevelSlider
      label={t(`mics.${level}`)}
      name={`${mic.label}: ${t(`mics.${level}`)}`}
      format={level === "gate" ? gateText : undefined}
      min={MIC_LEVELS[level].min}
      max={MIC_LEVELS[level].max}
      step={1}
      value={value}
      onSend={setValue}
    />
  );
};

// One empty list, so the live state's selector gives the same one each time.
const NO_MICS: MicInfo[] = [];

// The display's mics, each with its gain, echo and noise gate. The display
// can open one device and channel twice, so a row's key is its id and
// place.
const Mics = () => {
  const mics = useLiveState((state) => state?.mics ?? NO_MICS);
  return (
    <div className={styles.setting}>
      <h3 className={styles.label}>{t("mics.label")}</h3>
      {mics.length === 0 ? (
        <p className={styles.text}>{t("mics.none")}</p>
      ) : (
        <ul className={styles.mics}>
          {mics.map((mic, index) => (
            <li key={`${mic.id}-${index}`}>
              <span className={styles.text}>{mic.label}</span>
              <MicLevelSlider mic={mic} level="gain" />
              <MicLevelSlider mic={mic} level="echo" />
              <MicLevelSlider mic={mic} level="gate" />
            </li>
          ))}
        </ul>
      )}
      {mics.length > 0 && <p className={styles.help}>{t("mics.gateHelp")}</p>}
    </div>
  );
};

// Signing in and out as an admin with the password the host set. Signed
// in, the admin's controls: the song volume, the guide melody's level and
// the mics' levels. While the host has made everyone an admin, it says so,
// and Sign out shows only for a phone that signed in (it would do nothing
// for one that didn't).
const Admin = () => {
  const { adminToken } = useUserIdentity();
  const isAdmin = useIsAdmin();
  const everyoneIsAdmin = useLiveState(
    (state) => state?.config.everyoneIsAdmin ?? false,
  );
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed in, until whoami says so.
  const confirming = adminToken !== null && isAdmin !== true;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      await adminSignIn(password);
      setPassword("");
    } catch (err) {
      setError(signInError(err));
    } finally {
      setPending(false);
    }
  };

  const leave = async () => {
    setPending(true);
    await adminSignOut();
    setPending(false);
  };

  if (isAdmin === true) {
    return (
      <>
        <p className={styles.text} role="status">
          {t(everyoneIsAdmin ? "settings.everyoneAdmin" : "settings.signedIn")}
        </p>
        <div className={styles.setting}>
          <SongVolumeSlider />
        </div>
        <GuideMelodySlider />
        <Mics />
        {adminToken !== null && (
          <div className={styles.setting}>
            <Button variant="secondary" disabled={pending} onClick={leave}>
              {t("settings.signOut")}
            </Button>
          </div>
        )}
      </>
    );
  }
  return (
    <form className={styles.setting} onSubmit={submit}>
      <TextField
        label={t("settings.adminPassword")}
        type="password"
        autoComplete="current-password"
        value={password}
        onValueChange={setPassword}
      />
      <Button
        type="submit"
        variant="secondary"
        disabled={password === "" || pending || confirming}
      >
        {t("settings.signIn")}
      </Button>
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
};

// How this phone's Joysound songs show their lyrics on the TV, unless the
// song page says otherwise.
const LyricsOnTheTv = () => {
  const [mode, setMode] = useState(savedLyricsMode);
  return (
    <div className={styles.setting}>
      <LyricsModeChoice
        label={t("settings.tvLyrics")}
        selected={mode}
        onSelect={(next) => {
          saveLyricsMode(next);
          setMode(next);
        }}
      />
      <p className={styles.help}>{t("lyricsMode.help")}</p>
    </div>
  );
};

// The phone's settings in groups: its nickname; its language, readings and
// theme; the lyrics its songs show on the TV; and the admin sign-in and
// controls. On a first visit, just the nickname (and the
// language, to read the rest in).
const SettingsPage = ({ firstVisit = false }: { firstVisit?: boolean }) => (
  <div className={styles.page}>
    <Group heading={t("settings.you")}>
      <Nickname firstVisit={firstVisit} />
    </Group>
    <Group heading={t("settings.thisPhone")}>
      <LanguagePicker />
      {!firstVisit && (
        <>
          <ReadingsPicker />
          <ThemePicker />
        </>
      )}
    </Group>
    {!firstVisit && (
      <>
        <Group heading={t("settings.onTheTv")}>
          <LyricsOnTheTv />
        </Group>
        <Group heading={t("settings.admin")}>
          <Admin />
        </Group>
      </>
    )}
  </div>
);

export default SettingsPage;
