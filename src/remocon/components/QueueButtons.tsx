import formatDuration from "format-duration";
import React, { useState } from "react";

import {
  LYRICS_MODES,
  type DamSongDetail,
  type JoysoundSongDetail,
  type LyricsMode,
  type QueueSongInput,
  type VocalType,
} from "../../common/api";
import useDownloadButtonText, {
  DOWNLOADING,
  downloadButtonLabel,
  QUEUED,
  WAITING_FOR_SERVER,
} from "../hooks/useDownloadButtonText";
import useQueueSong from "../hooks/useQueueSong";
import { t } from "../i18n";
import { Button, Tabs, type ButtonVariant } from "./ui";
import * as styles from "./QueueButtons.module.scss";

interface QueueButtonProps {
  label: string;
  song: QueueSongInput;
  variant?: ButtonVariant;
  disabled?: boolean;
  // True from the press until the button is ready again.
  onBusyChange?: (busy: boolean) => void;
}

// Queues one song and says how it went: waiting for the server, the wait
// (DAM), the download's progress, or why it couldn't (A1's failures, or the
// server's reason, such as the song already being queued).
export const QueueButton = ({
  label,
  song,
  variant = "primary",
  disabled,
  onBusyChange,
}: QueueButtonProps) => {
  const [text, setText] = useDownloadButtonText(
    label,
    {
      kind: song.kind,
      songId: song.songId,
      suffix: song.kind === "joysound" ? song.youtubeVideoId : null,
    },
    () => onBusyChange?.(false),
  );
  // A DAM song joins the queue at once (it downloads in the background);
  // the others download first.
  const queueSong = useQueueSong(setText, (eta) =>
    song.kind === "dam"
      ? `${QUEUED}: ${formatDuration(eta * 1000)}`
      : DOWNLOADING,
  );

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onBusyChange?.(true);
    setText(WAITING_FOR_SERVER);
    queueSong(song, e);
  };

  return (
    <Button
      variant={variant}
      full
      disabled={disabled || text !== label}
      onClick={onClick}
    >
      {downloadButtonLabel(text)}
    </Button>
  );
};

const VOCAL_LABELS: Record<VocalType, () => string> = {
  NORMAL: () => t("queueButton.song"),
  GUIDE_MALE: () => t("queueButton.guideMale"),
  GUIDE_FEMALE: () => t("queueButton.guideFemale"),
  UNKNOWN: () => t("queueButton.guide"),
};

type Props =
  | { kind: "dam"; song: DamSongDetail }
  | {
      kind: "joysound";
      song: JoysoundSongDetail;
      // The YouTube video to play behind the lyrics, if any.
      youtubeVideoId: string | null;
      // While that video is being checked.
      disabled: boolean;
    };

const LYRICS_MODE_KEY = "lyricsMode";

// The phone's choice of how Joysound lyrics show on the TV (the profile's
// "Lyrics on the TV"), kept in localStorage; kana without one.
export function savedLyricsMode(): LyricsMode {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LYRICS_MODE_KEY);
  } catch {
    // Storage blocked: the default.
  }
  return LYRICS_MODES.find((mode) => mode === saved) ?? "kana";
}

export function saveLyricsMode(mode: LyricsMode) {
  try {
    localStorage.setItem(LYRICS_MODE_KEY, mode);
  } catch {
    // Not saved; the song page still starts at kana.
  }
}

export const LyricsModeTabs = (props: {
  selected: LyricsMode;
  onSelect: (mode: LyricsMode) => void;
}) => (
  <Tabs<LyricsMode>
    label={t("lyricsMode.label")}
    tabs={LYRICS_MODES.map((id) => ({ id, label: t(`lyricsMode.${id}`) }))}
    {...props}
  />
);

// A DAM or Joysound song's queue buttons: one per DAM vocal type (with or
// without a guide vocal), or Joysound's one button with the lyrics' mode
// above it. One at a time.
const QueueButtons = (props: Props) => {
  const [busy, setBusy] = useState(false);
  const [lyricsMode, setLyricsMode] = useState(savedLyricsMode);
  const { song } = props;
  const base = {
    songId: song.id,
    name: song.name,
    artistName: song.artistName,
  };
  const buttons: { label: string; input: QueueSongInput }[] =
    props.kind === "dam"
      ? props.song.vocalTypes.map((vocalType, i) => ({
          label: VOCAL_LABELS[vocalType](),
          input: {
            ...base,
            kind: "dam",
            playtime: props.song.playtime,
            streamingUrlIdx: i,
          },
        }))
      : [
          {
            label: t("queueButton.song"),
            input: {
              ...base,
              kind: "joysound",
              playtime: null,
              lyricsMode,
              youtubeVideoId: props.youtubeVideoId,
            },
          },
        ];

  return (
    <div className={styles.buttons}>
      {props.kind === "joysound" && (
        <>
          <h3 className={styles.heading}>{t("lyricsMode.label")}</h3>
          <LyricsModeTabs selected={lyricsMode} onSelect={setLyricsMode} />
        </>
      )}
      {buttons.map(({ label, input }, i) => (
        <QueueButton
          key={i}
          label={label}
          song={input}
          variant={i === 0 ? "primary" : "secondary"}
          disabled={busy || (props.kind === "joysound" && props.disabled)}
          onBusyChange={setBusy}
        />
      ))}
    </div>
  );
};

export default QueueButtons;
