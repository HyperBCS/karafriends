import React, { useEffect, useRef } from "react";

import type { SharedQueueItem } from "../common/api";
import { useLiveState } from "../common/apiClient";
import AdhocLyrics from "./AdhocLyrics";
import JoysoundRenderer from "./JoysoundRenderer";
import loadKuroshiro from "./kuroshiro";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import useGuideMelody from "./useGuideMelody";
import useSongPlayer, { type Announcement } from "./useSongPlayer";
import KarafriendsAudio from "./webAudio";

const showsRomaji = (song: SharedQueueItem | null) =>
  song?.kind === "joysound" && song.lyricsMode !== "kana";

// A captions track, on from the start. It's in the video only while its
// song plays: a <track> kept from song to song and given a new src (or
// none) let go of its cues, but Chromium went on drawing the one showing
// over the next song.
const showTrack = (track: HTMLTrackElement | null) => {
  if (track) track.track.mode = "showing";
};

// The video, with the song's lyrics and pitch bars over it.
function Player(props: {
  mics: InputDevice[];
  audio: KarafriendsAudio;
  announce: (announcement: Announcement) => void;
  avOffsetMs: number;
  // Whether DAM and Joysound songs show the pitch bars (Settings, Display).
  pitchBars: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { overlay, pitchShiftSemis } = useSongPlayer({
    videoRef,
    audio: props.audio,
    announce: props.announce,
  });
  // Read once the song has loaded (its lyrics have), and only while the
  // bars show. Not from a guide-vocal version: a voice, not a melody line.
  const guideMelody = useGuideMelody(
    props.pitchBars &&
      overlay?.kind === "joysound" &&
      overlay.telop !== null &&
      !overlay.guideVocal
      ? overlay
      : null,
  );
  const melody = !props.pitchBars
    ? null
    : overlay?.kind === "dam"
      ? overlay.melody
      : overlay?.kind === "joysound"
        ? guideMelody
        : null;
  // Kuromoji's dictionary loads once a Joysound song with romaji is queued,
  // so it's ready by the song's title card.
  const romajiSoon = useLiveState(
    (state) =>
      showsRomaji(state?.currentSong ?? null) ||
      (state?.queue.some(showsRomaji) ?? false),
  );
  useEffect(() => {
    if (romajiSoon) loadKuroshiro().catch(console.error);
  }, [romajiSoon]);

  return (
    <div className="karaVidContainer">
      {overlay?.kind === "joysound" && overlay.telop !== null ? (
        <JoysoundRenderer
          telop={overlay.telop}
          lyricsMode={overlay.lyricsMode}
          videoRef={videoRef}
          avOffsetMs={props.avOffsetMs}
          pitchBars={props.pitchBars}
        />
      ) : null}
      {melody ? (
        <PianoRoll
          melody={melody}
          videoRef={videoRef}
          mics={props.mics}
          pitchShiftSemis={pitchShiftSemis}
          avOffsetMs={props.avOffsetMs}
        />
      ) : null}
      <video
        className="karaVid"
        ref={videoRef}
        crossOrigin="anonymous"
        controls
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
      >
        {overlay?.kind === "youtube" && overlay.captions !== null ? (
          <track
            key={overlay.captions}
            ref={showTrack}
            kind="subtitles"
            src={overlay.captions}
            default
          />
        ) : null}
      </video>
      {overlay?.kind === "youtube" && overlay.adhocLyrics ? (
        <AdhocLyrics />
      ) : null}
    </div>
  );
}

export default Player;
