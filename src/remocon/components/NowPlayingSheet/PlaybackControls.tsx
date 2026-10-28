import React, { useEffect, useRef, useState } from "react";

import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import useGuideMelodyLevel from "../../../common/hooks/useGuideMelodyLevel";
import usePitchShiftSemis from "../../../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../../../common/hooks/usePlaybackState";
import { t } from "../../i18n";
import { MdPause, MdPlayArrow, MdReplay, MdSkipNext } from "../../icons";
import { IconButton } from "../ui";
import * as styles from "./NowPlayingSheet.module.scss";

// The guide melody's level. While the thumb is dragged it moves here only;
// letting go (the input's change event, which a key press also fires)
// sends the level once, so the echo of an earlier step can't pull the
// thumb back or settle on a stale level.
const GuideMelodySlider = ({ disabled }: { disabled: boolean }) => {
  const { guideMelodyLevel, setGuideMelodyLevel } = useGuideMelodyLevel();
  const [held, setHeld] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // React's onChange is the input event, which comes with every step.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const send = () => {
      setGuideMelodyLevel(Number(el.value));
      setHeld(null);
    };
    el.addEventListener("change", send);
    return () => el.removeEventListener("change", send);
  });

  return (
    <label className={styles.guideMelody}>
      {t("guideMelody.label")}
      <input
        ref={input}
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={held ?? guideMelodyLevel}
        disabled={disabled}
        onChange={(e) => setHeld(Number(e.target.value))}
      />
    </label>
  );
};

// Restart, play or pause, skip, and the key. In supervised mode they're
// dimmed for anyone but an admin and the current singer, as the server
// would refuse them (setPlaybackState in src/main/api.ts). During a
// Joysound song, the guide melody's level too, for admins.
const PlaybackControls = () => {
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const supervisedMode = useLiveState(
    (state) => state?.config.supervisedMode ?? false,
  );
  const isMine = useLiveState((state) => state?.currentSong?.isMine === true);
  const isAdmin = useIsAdmin();
  // Only Joysound songs have a guide melody to mix in (setGuideMelodyLevel,
  // admins only).
  const isJoysound = useLiveState(
    (state) => state?.currentSong?.kind === "joysound",
  );
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
      {isJoysound && <GuideMelodySlider disabled={isAdmin !== true} />}
    </>
  );
};

export default PlaybackControls;
