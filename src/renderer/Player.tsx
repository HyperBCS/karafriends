import React, { useRef } from "react";

import { KuroshiroSingleton } from "../common/joysoundParser";
import AdhocLyrics from "./AdhocLyrics";
import JoysoundRenderer from "./JoysoundRenderer";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import useGuideMelody from "./useGuideMelody";
import useSongPlayer, { type Announcement } from "./useSongPlayer";
import KarafriendsAudio from "./webAudio";

// The video, with the song's lyrics and pitch bars over it.
function Player(props: {
  mics: InputDevice[];
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
  announce: (announcement: Announcement) => void;
  avOffsetMs: number;
  // Whether DAM and Joysound songs show the pitch bars (Settings, Display).
  pitchBars: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const { overlay, pitchShiftSemis } = useSongPlayer({
    videoRef,
    trackRef,
    audio: props.audio,
    announce: props.announce,
  });
  // Read once the song has loaded (its lyrics have), and only while the
  // bars show.
  const guideMelody = useGuideMelody(
    props.pitchBars && overlay?.kind === "joysound" && overlay.telop !== null
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

  return (
    <div className="karaVidContainer">
      {overlay?.kind === "joysound" && overlay.telop !== null ? (
        <JoysoundRenderer
          telop={overlay.telop}
          lyricsMode={overlay.lyricsMode}
          kuroshiro={props.kuroshiro}
          videoRef={videoRef}
          avOffsetMs={props.avOffsetMs}
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
        <track ref={trackRef} kind="subtitles" default />
      </video>
      {overlay?.kind === "youtube" && overlay.adhocLyrics ? (
        <AdhocLyrics />
      ) : null}
    </div>
  );
}

export default Player;
