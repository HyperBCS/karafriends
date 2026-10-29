import classnames from "classnames";
import React, { useEffect, useState } from "react";

import {
  LYRICS_MODES,
  type DamSongDetail,
  type JoysoundSongDetail,
  type LyricsMode,
  type QueueSongInput,
  type VocalType,
} from "../../common/api";
import { useApiMutation } from "../../common/apiQueries";
import { joysoundFilesId } from "../../common/songFiles";
import { getItem, setItem } from "../../common/storage";
import useQueueButtonStatus, {
  statusLabel,
} from "../hooks/useQueueButtonStatus";
import useReadings from "../hooks/useReadings";
import { t } from "../i18n";
import { Button, SegmentedControl, type ButtonVariant } from "./ui";
import * as styles from "./QueueButtons.module.scss";

interface QueueButtonProps {
  label: string;
  song: QueueSongInput;
  variant?: ButtonVariant;
  disabled?: boolean;
  // True from the press until the button is ready again.
  onBusyChange?: (busy: boolean) => void;
}

// Queues one song (the queueSong method) and says how it went: waiting for
// the server, the wait, the download's progress, or why it couldn't (A1's
// failures, or the server's reason, such as the queue limit).
export const QueueButton = ({
  label,
  song,
  variant = "primary",
  disabled,
  onBusyChange,
}: QueueButtonProps) => {
  const [status, setStatus] = useQueueButtonStatus({
    kind: song.kind,
    songId:
      song.kind === "joysound"
        ? joysoundFilesId(song.songId, song.guideVocal)
        : song.songId,
    suffix: song.kind === "joysound" ? song.youtubeVideoId : null,
  });
  const busy = status.is !== "idle";
  useEffect(() => onBusyChange?.(busy), [busy]);

  const { mutate } = useApiMutation("queueSong", {
    onSuccess: (result) =>
      setStatus(
        !result.ok
          ? { is: "error", reason: result.reason }
          : // A DAM song joins the queue at once (it downloads in the
            // background); the others download first.
            song.kind === "dam"
            ? { is: "queued", eta: result.eta }
            : { is: "downloading", progress: null, eta: result.eta },
      ),
    onError: (err) => setStatus({ is: "error", reason: err.message }),
  });
  // The song shows on the TV the way this phone reads it.
  const readingsMode = useReadings();

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setStatus({ is: "waiting" });
    // Holding shift asks to put it next (only an admin's request does).
    mutate({ ...song, tryHeadOfQueue: e.shiftKey, readingsMode });
  };

  return (
    <Button
      variant={variant}
      full
      disabled={disabled || busy}
      onClick={onClick}
      className={styles.queueButton}
    >
      {statusLabel(status, label)}
      {status.is === "downloading" && (
        <DownloadBar progress={status.progress} />
      )}
    </Button>
  );
};

// A download's progress along the button's foot, in its text's color: filled
// to the fraction, or a sweep while that isn't known yet. The label says
// the percentage, so screen readers skip it.
const DownloadBar = ({ progress }: { progress: number | null }) => (
  <span className={styles.progress} aria-hidden="true">
    <span className={styles.track} />
    <span
      className={classnames(styles.fill, progress === null && styles.unknown)}
      style={
        progress === null
          ? undefined
          : { width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }
      }
    />
  </span>
);

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

// The phone's choice of how Joysound lyrics show on the TV (in the
// settings, under "On the TV"), kept in localStorage; kana without one.
export function savedLyricsMode(): LyricsMode {
  const saved = getItem(LYRICS_MODE_KEY);
  return LYRICS_MODES.find((mode) => mode === saved) ?? "kana";
}

export const saveLyricsMode = (mode: LyricsMode) =>
  setItem(LYRICS_MODE_KEY, mode);

// Kana, romaji or both: on a Joysound song's page, and in the settings.
export const LyricsModeChoice = (props: {
  label: string;
  selected: LyricsMode;
  onSelect: (mode: LyricsMode) => void;
}) => (
  <SegmentedControl<LyricsMode>
    choices={LYRICS_MODES.map((id) => ({ id, label: t(`lyricsMode.${id}`) }))}
    {...props}
  />
);

// A DAM or Joysound song's queue buttons: one per DAM vocal type (with or
// without a guide vocal), or Joysound's, with its guide-vocal version's
// under it if it has one, and the lyrics' mode above them. One at a time.
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
            // For the queue's and history's rows (WithReading). The
            // artist's comes from the row that opened the page (SongPage),
            // "" when there was none.
            nameYomi: props.song.nameYomi || undefined,
            artistNameYomi: props.song.artistNameYomi || undefined,
            playtime: props.song.playtime,
            streamingUrlIdx: i,
          },
        }))
      : [false, ...(props.song.guideVocal ? [true] : [])].map((guideVocal) => ({
          label: t(guideVocal ? "queueButton.guide" : "queueButton.song"),
          input: {
            ...base,
            kind: "joysound",
            playtime: null,
            lyricsMode,
            youtubeVideoId: props.youtubeVideoId,
            ...(guideVocal && { guideVocal }),
          },
        }));

  return (
    <div className={styles.buttons}>
      {props.kind === "joysound" && (
        <LyricsModeChoice
          label={t("lyricsMode.label")}
          selected={lyricsMode}
          onSelect={setLyricsMode}
        />
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
