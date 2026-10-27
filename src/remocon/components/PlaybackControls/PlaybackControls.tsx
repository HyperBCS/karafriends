import classnames from "classnames";
import React from "react";

import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import usePlaybackState from "../../../common/hooks/usePlaybackState";
import { MdPause, MdPlayArrow, MdReplay, MdSkipNext } from "../../icons";
import PitchControls from "../PitchControls/PitchControls";
import * as styles from "./PlaybackControls.module.scss";

const PlaybackControls = () => {
  const { playbackState, setPlaybackState } = usePlaybackState();
  const isPlaybackControllable = ["PLAYING", "PAUSED"].includes(playbackState);

  const live = useLiveState();
  const isAdmin = useIsAdmin();

  // What the server allows (setPlaybackState in src/main/api.ts): in
  // supervised mode, an admin or the current singer, from the phone that
  // queued the song.
  const isUserEntitled =
    !live?.config.supervisedMode ||
    isAdmin === true ||
    live.currentSong?.isMine === true;

  const disabled = !isPlaybackControllable || !isUserEntitled;

  return (
    <>
      <div
        className={classnames(styles.controls, { [styles.disabled]: disabled })}
      >
        <div
          role="button"
          aria-label="Restart"
          aria-disabled={disabled}
          onClick={() => setPlaybackState("RESTARTING")}
        >
          <MdReplay />
        </div>
        <div
          className={styles.playPause}
          role="button"
          aria-label={playbackState === "PLAYING" ? "Pause" : "Play"}
          aria-disabled={disabled}
          onClick={() =>
            setPlaybackState(playbackState === "PAUSED" ? "PLAYING" : "PAUSED")
          }
        >
          {playbackState === "PLAYING" ? <MdPause /> : <MdPlayArrow />}
        </div>
        <div
          role="button"
          aria-label="Skip"
          aria-disabled={disabled}
          onClick={() => setPlaybackState("SKIPPING")}
        >
          <MdSkipNext />
        </div>
      </div>
      <PitchControls disabled={disabled} />
    </>
  );
};

export default PlaybackControls;
