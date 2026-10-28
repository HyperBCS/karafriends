import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  adminSignIn,
  adminSignOut,
  ApiCallError,
  useIsAdmin,
  useLiveState,
} from "../../common/apiClient";
import { useApiMutation } from "../../common/apiQueries";
import useGuideMelodyLevel from "../../common/hooks/useGuideMelodyLevel";
import useOptimisticValue from "../../common/hooks/useOptimisticValue";
import {
  LyricsModeTabs,
  saveLyricsMode,
  savedLyricsMode,
} from "../components/QueueButtons";
import { Button, InlineError, Tabs, TextField } from "../components/ui";
import useReadings, { saveReadings } from "../hooks/useReadings";
import useUserIdentity, { saveNickname } from "../hooks/useUserIdentity";
import { LANGUAGES, t, useLanguage, type Language } from "../i18n";
import {
  READINGS_MODES,
  type MicInfo,
  type ReadingsMode,
} from "../../common/api";
import { currentTheme, saveTheme, THEMES, type Theme } from "../theme";
import * as styles from "./ProfilePage.module.scss";

// What to tell a guest whose sign-in failed.
function signInError(err: unknown): string {
  if (err instanceof ApiCallError) {
    if (err.status === 403) return t("profile.wrongPassword");
    if (err.status === 409) return t("profile.noPassword");
    if (err.status === 429) return t("profile.tooManyTries");
    return t("profile.signInFailed", { reason: err.message });
  }
  // fetch() itself failed: no connection.
  return t("common.offline");
}

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
    <form className={styles.section} onSubmit={submit}>
      {firstVisit && <p className={styles.text}>{t("profile.firstVisit")}</p>}
      <TextField
        label={t("profile.nickname")}
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
        {t(firstVisit ? "profile.start" : "profile.saveNickname")}
      </Button>
    </form>
  );
};

const LanguagePicker = () => {
  const { language, setLanguage } = useLanguage();
  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("language.label")}</h2>
      <Tabs<Language>
        label={t("language.label")}
        tabs={LANGUAGES.map((id) => ({ id, label: t(`language.${id}`) }))}
        selected={language}
        onSelect={setLanguage}
      />
    </div>
  );
};

// How this phone shows song titles and artists: as written, or in their
// kana reading or in romaji instead (where DAM gives a reading). Songs it
// queues show that way on the TV too.
const ReadingsPicker = () => {
  const readings = useReadings();
  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("readings.label")}</h2>
      <Tabs<ReadingsMode>
        label={t("readings.label")}
        tabs={READINGS_MODES.map((id) => ({ id, label: t(`readings.${id}`) }))}
        selected={readings}
        onSelect={saveReadings}
      />
    </div>
  );
};

// Light, dark, or as the phone is set (theme.ts).
const ThemePicker = () => {
  const [theme, setTheme] = useState(currentTheme);
  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("theme.label")}</h2>
      <Tabs<Theme>
        label={t("theme.label")}
        tabs={THEMES.map((id) => ({ id, label: t(`theme.${id}`) }))}
        selected={theme}
        onSelect={(next) => {
          saveTheme(next);
          setTheme(next);
        }}
      />
    </div>
  );
};

// Asks the phone to show a notification when this phone's song is up soon
// or couldn't be downloaded (useQueueNotifications). Browsers only ask
// once; after that, it's the browser's setting.
const Notifications = () => {
  const supported = "Notification" in window;
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "denied",
  );
  if (!supported) return null;

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("profile.notifications")}</h2>
      {permission === "default" ? (
        <Button
          variant="secondary"
          onClick={async () =>
            setPermission(await Notification.requestPermission())
          }
        >
          {t("profile.notificationsOn")}
        </Button>
      ) : (
        <p className={styles.text}>
          {t(
            permission === "granted"
              ? "profile.notificationsAllowed"
              : "profile.notificationsBlocked",
          )}
        </p>
      )}
    </div>
  );
};

interface LevelSliderProps {
  label: string;
  // The slider's accessible name: the label without the value, or one that
  // says whose when the label alone doesn't.
  name?: string;
  // What the value is multiplied by to show as a percent.
  scale?: number;
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

  return (
    <label className={styles.slider}>
      {`${label} ${Math.round((held ?? value) * scale)}%`}
      <input
        ref={input}
        aria-label={name}
        type="range"
        min={min}
        max={max}
        step={step}
        value={held ?? value}
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

// How loud Joysound's guide melody plays, whatever is playing.
const GuideMelodySlider = () => {
  const { guideMelodyLevel, setGuideMelodyLevel } = useGuideMelodyLevel();
  return (
    <>
      <LevelSlider
        label={t("guideMelody.label")}
        scale={100}
        min={0}
        max={1}
        step={0.1}
        value={guideMelodyLevel}
        onSend={setGuideMelodyLevel}
      />
      <p className={styles.text}>{t("guideMelody.help")}</p>
    </>
  );
};

// The song's volume on the display, 0 to 100 %.
const SongVolumeSlider = () => {
  const live = useLiveState((state) => state?.songVolume ?? 100);
  const [volume, setPending, clearPending] = useOptimisticValue(live);
  const { mutate } = useApiMutation("setSongVolume", {
    onError: (err) => {
      console.error("Couldn't change the song volume:", err);
      clearPending();
    },
  });
  return (
    <LevelSlider
      label={t("songVolume.label")}
      min={0}
      max={100}
      step={5}
      value={volume}
      onSend={(next) => {
        setPending(next);
        mutate({ volume: next });
      }}
    />
  );
};

// One of a mic's levels: gain (0 to 200 %) or echo (0 to 100 %).
const MicLevelSlider = ({
  mic,
  level,
}: {
  mic: MicInfo;
  level: "gain" | "echo";
}) => {
  const [value, setPending, clearPending] = useOptimisticValue(mic[level]);
  const { mutate } = useApiMutation("setMicLevels", {
    onError: (err) => {
      console.error(`Couldn't change the mic's ${level}:`, err);
      clearPending();
    },
  });
  return (
    <LevelSlider
      label={t(`mics.${level}`)}
      name={`${mic.label}: ${t(`mics.${level}`)}`}
      min={0}
      max={level === "gain" ? 200 : 100}
      step={1}
      value={value}
      onSend={(next) => {
        setPending(next);
        mutate({ id: mic.id, [level]: next });
      }}
    />
  );
};

// One empty list, so the live state's selector gives the same one each time.
const NO_MICS: MicInfo[] = [];

// The display's mics, each with its gain and echo. The display can open
// one device and channel twice, so a row's key is its id and place.
const Mics = () => {
  const mics = useLiveState((state) => state?.mics ?? NO_MICS);
  return (
    <>
      <h3 className={styles.heading}>{t("mics.label")}</h3>
      {mics.length === 0 ? (
        <p className={styles.text}>{t("mics.none")}</p>
      ) : (
        <ul className={styles.mics}>
          {mics.map((mic, index) => (
            <li key={`${mic.id}-${index}`}>
              <span className={styles.text}>{mic.label}</span>
              <MicLevelSlider mic={mic} level="gain" />
              <MicLevelSlider mic={mic} level="echo" />
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

// Signing in and out as an admin with the password the host set. Signed
// in, the admin's controls: the song volume, the guide melody's level and
// the mics' levels.
const Admin = () => {
  const { adminToken } = useUserIdentity();
  const isAdmin = useIsAdmin();
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
      <div className={styles.section}>
        <h2 className={styles.heading}>{t("profile.admin")}</h2>
        <p className={styles.text} role="status">
          {t("profile.signedIn")}
        </p>
        <SongVolumeSlider />
        <GuideMelodySlider />
        <Mics />
        <Button variant="secondary" disabled={pending} onClick={leave}>
          {t("profile.signOut")}
        </Button>
      </div>
    );
  }
  return (
    <form className={styles.section} onSubmit={submit}>
      <h2 className={styles.heading}>{t("profile.admin")}</h2>
      <TextField
        label={t("profile.adminPassword")}
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
        {t("profile.signIn")}
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
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("lyricsMode.label")}</h2>
      <LyricsModeTabs
        selected={mode}
        onSelect={(next) => {
          saveLyricsMode(next);
          setMode(next);
        }}
      />
      <p className={styles.text}>{t("lyricsMode.help")}</p>
    </div>
  );
};

// The phone's nickname, language, readings, theme, notifications, and the
// admin sign-in and controls. On a first visit, just the nickname (and the
// language, to read the rest in).
const ProfilePage = ({ firstVisit = false }: { firstVisit?: boolean }) => (
  <div className={styles.profile}>
    <Nickname firstVisit={firstVisit} />
    <LanguagePicker />
    {!firstVisit && (
      <>
        <ReadingsPicker />
        <ThemePicker />
        <Notifications />
        <Admin />
        <LyricsOnTheTv />
      </>
    )}
  </div>
);

export default ProfilePage;
