import React from "react";

import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import usePitchShiftSemis from "../../../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../../../common/hooks/usePlaybackState";
import { t } from "../../i18n";
import { MdPause, MdPlayArrow, MdReplay, MdSkipNext } from "../../icons";
import { IconButton } from "../ui";
import * as styles from "./NowPlayingSheet.module.scss";

// Restart, play or pause, skip, and the key. In supervised mode they're
// dimmed for anyone but an admin and the current singer, as the server
// would refuse them (setPlaybackState in src/main/api.ts).
const PlaybackControls = () => {
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const supervisedMode = useLiveState(
    (state) => state?.config.supervisedMode ?? false,
  );
  const isMine = useLiveState((state) => state?.currentSong?.isMine === true);
  const isAdmin = useIsAdmin();

  const isEntitled = !supervisedMode || isAdmin === true || isMine;
  const disabled =
    !["PLAYING", "PAUSED"].includes(playbackState) || !isEntitled;
  const playing = playbackState === "PLAYING";

  return (
    <>
      <div className={styles.group}>
        <IconButton
          label={t("playback.restart")}
          icon={<MdReplay />}
          aria-disabled={disabled}
          onClick={() => setPlaybackState("RESTARTING")}
        />
        <IconButton
          label={playing ? t("playback.pause") : t("playback.play")}
          icon={playing ? <MdPause /> : <MdPlayArrow />}
          tone="accent"
          aria-disabled={disabled}
          onClick={() => setPlaybackState(playing ? "PAUSED" : "PLAYING")}
        />
        <IconButton
          label={t("playback.skip")}
          icon={<MdSkipNext />}
          aria-disabled={disabled}
          onClick={() => setPlaybackState("SKIPPING")}
        />
      </div>
      <div className={styles.group}>
        <IconButton
          label={t("pitch.lower")}
          icon="♭"
          aria-disabled={disabled}
          onClick={() => setPitchShiftSemis(pitchShiftSemis - 1)}
        />
        <span className={styles.key} role="status" aria-label={t("pitch.key")}>
          {pitchShiftSemis}
        </span>
        <IconButton
          label={t("pitch.raise")}
          icon="♯"
          aria-disabled={disabled}
          onClick={() => setPitchShiftSemis(pitchShiftSemis + 1)}
        />
      </div>
    </>
  );
};

export default PlaybackControls;
