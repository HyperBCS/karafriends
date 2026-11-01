import formatDuration from "format-duration";
import React from "react";

import { useLiveState } from "../../../common/apiClient";
import { introLeft } from "../../../common/currentSong";
import { usePlayed } from "../../../common/hooks/useQueue";
import { t } from "../../i18n";
import { MdFastForward } from "../../icons";
import * as styles from "./NowPlayingSheet.module.scss";
import { usePlaybackControl } from "./PlaybackControls";

// "Skip intro", floating just above the now-playing sheet, open or folded,
// while a long intro plays (introLeft: when the TV knows where the singing
// starts, and at least MIN_INTRO_SKIP_S of intro is left), with how much it
// would skip counting down. For a phone that may control the song, as the
// transport. One tap, no question: it only ever skips intro, to a few
// seconds before the first line, and the TV says who did it.
const SkipIntro = () => {
  const { song, setPlaybackState, active, isEntitled } = usePlaybackControl();
  const lyricsStart = useLiveState(
    (state) => state?.currentSongLyricsStart ?? null,
  );
  // Ticking only for a song that could have it.
  const left = introLeft(lyricsStart, usePlayed(lyricsStart !== null));
  if (song === null || !active || !isEntitled || left === null) return null;

  return (
    <button
      type="button"
      className={styles.skipIntro}
      // Without the countdown, which changes every second.
      aria-label={t("playback.skipIntro")}
      onClick={() => setPlaybackState("SKIPPING_INTRO", song)}
    >
      <span className={styles.skipIntroIcon} aria-hidden="true">
        <MdFastForward />
      </span>
      {t("playback.skipIntro")}
      <span className={styles.skipIntroLeft} aria-hidden="true">
        {formatDuration(left * 1000)}
      </span>
    </button>
  );
};

export default SkipIntro;
