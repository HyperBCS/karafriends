import formatDuration from "format-duration";
import React from "react";

import { useLiveState } from "../../../common/apiClient";
import { useSongProgress } from "../../../common/hooks/useQueue";
import { t, useLanguage, type Language } from "../../i18n";
import * as styles from "./SongProgress.module.scss";

// Seconds in words, in the phone's language: "1 minute 12 seconds".
function inWords(seconds: number, language: Language): string {
  const unit = (value: number, unit: "minute" | "second") =>
    new Intl.NumberFormat(language, {
      style: "unit",
      unit,
      unitDisplay: "long",
    }).format(value);
  const minutes = Math.floor(seconds / 60);
  const rest = unit(seconds % 60, "second");
  return minutes > 0 ? `${unit(minutes, "minute")} ${rest}` : rest;
}

// How far into the current song the party is: a thin bar, and "1:12 / 4:05"
// on its right. The bar slides along once a second; after a seek, a restart
// or a new song (the song's start time changes) it starts afresh where the
// song is, without sliding there. Nothing while no song plays or its length
// isn't known. <span>s only, so it may go inside the sheet's toggle.
const SongProgress = () => {
  const progress = useSongProgress();
  const startedAt = useLiveState(
    (state) => state?.currentSongStartedAt ?? null,
  );
  const { language } = useLanguage();
  if (!progress) return null;
  const { position, length } = progress;
  return (
    <span
      className={styles.progress}
      role="progressbar"
      aria-label={t("sheet.progress")}
      aria-valuemin={0}
      aria-valuemax={length}
      aria-valuenow={position}
      aria-valuetext={t("sheet.progressTime", {
        position: inWords(position, language),
        length: inWords(length, language),
      })}
    >
      <span className={styles.track}>
        <span
          key={String(startedAt)}
          className={styles.played}
          style={{ width: `${(position / length) * 100}%` }}
        />
      </span>
      <span className={styles.time} aria-hidden="true">
        {`${formatDuration(position * 1000)} / ${formatDuration(length * 1000)}`}
      </span>
    </span>
  );
};

export default SongProgress;
