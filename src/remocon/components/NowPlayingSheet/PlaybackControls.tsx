import React from "react";

import type { PlaybackCommand } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { songKey } from "../../../common/currentSong";
import usePitchShiftSemis from "../../../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../../../common/hooks/usePlaybackState";
import { t } from "../../i18n";
import { MdPause, MdPlayArrow, MdReplay, MdSkipNext } from "../../icons";
import { IconButton } from "../ui";
import * as styles from "./NowPlayingSheet.module.scss";

// The key change with its sign: "+2", "−1" (a minus sign), "0".
export function signedKey(semis: number): string {
  if (semis > 0) return `+${semis}`;
  if (semis < 0) return `−${-semis}`;
  return "0";
}

interface TransportProps {
  playing: boolean;
  disabled: boolean;
  onRestart: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
}

// Restart, play or pause, and skip, close together in the middle of the
// sheet's toolbar: play or pause a big raised accent circle, the other two
// quieter beside it.
export const Transport = ({
  playing,
  disabled,
  onRestart,
  onPlayPause,
  onSkip,
}: TransportProps) => (
  <div className={styles.transport}>
    <IconButton
      label={t("playback.restart")}
      icon={<MdReplay />}
      tone="muted"
      aria-disabled={disabled}
      onClick={onRestart}
    />
    <IconButton
      label={playing ? t("playback.pause") : t("playback.play")}
      icon={playing ? <MdPause /> : <MdPlayArrow />}
      tone="filled"
      className={styles.play}
      aria-disabled={disabled}
      onClick={onPlayPause}
    />
    <IconButton
      label={t("playback.skip")}
      icon={<MdSkipNext />}
      tone="muted"
      aria-disabled={disabled}
      onClick={onSkip}
    />
  </div>
);

interface KeyStepperProps {
  semis: number;
  disabled: boolean;
  onChange: (semis: number) => void;
}

// The key as one control at the toolbar's end: ♭, the key with its sign
// under a small "Key", and ♯, in one sunken pill. The key itself is a
// status, read out as it changes.
export const KeyStepper = ({ semis, disabled, onChange }: KeyStepperProps) => (
  <div className={styles.key}>
    <IconButton
      label={t("pitch.lower")}
      icon="♭"
      aria-disabled={disabled}
      onClick={() => onChange(semis - 1)}
    />
    <span className={styles.keyValue}>
      <span className={styles.keyLabel} aria-hidden="true">
        {t("pitch.key")}
      </span>
      <span
        className={styles.keyNumber}
        role="status"
        aria-label={t("pitch.key")}
      >
        {signedKey(semis)}
      </span>
    </span>
    <IconButton
      label={t("pitch.raise")}
      icon="♯"
      aria-disabled={disabled}
      onClick={() => onChange(semis + 1)}
    />
  </div>
);

// The transport and the key, for the current song (each command names it,
// so a tap that crosses the song's end can't land on the next one). Dimmed
// while nothing plays or the TV loads the song (WAITING), and in supervised
// mode for anyone but an admin and the current singer, as the server would
// refuse them (setPlaybackState in src/main/api.ts), with a line under them
// saying so. (The guide melody's level is in Settings, for admins.)
const PlaybackControls = () => {
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const song = useLiveState((state) =>
    state?.currentSong ? songKey(state.currentSong) : null,
  );
  const supervisedMode = useLiveState(
    (state) => state?.config.supervisedMode ?? false,
  );
  const isMine = useLiveState((state) => state?.currentSong?.isMine === true);
  const isAdmin = useIsAdmin();
  const isEntitled = !supervisedMode || isAdmin === true || isMine;
  const active = song !== null && ["PLAYING", "PAUSED"].includes(playbackState);
  const disabled = !active || !isEntitled;
  const playing = playbackState === "PLAYING";
  const play = (next: PlaybackCommand) => {
    if (song !== null) setPlaybackState(next, song);
  };

  return (
    <>
      <Transport
        playing={playing}
        disabled={disabled}
        onRestart={() => play("RESTARTING")}
        onPlayPause={() => play(playing ? "PAUSED" : "PLAYING")}
        onSkip={() => play("SKIPPING")}
      />
      <KeyStepper
        semis={pitchShiftSemis}
        disabled={disabled}
        onChange={(semis) => {
          if (song !== null) setPitchShiftSemis(semis, song);
        }}
      />
      {active && supervisedMode && isAdmin === false && !isMine && (
        <p className={styles.note}>{t("playback.singerOnly")}</p>
      )}
    </>
  );
};

export default PlaybackControls;
