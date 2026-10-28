import React, { useRef } from "react";

import { KuroshiroSingleton } from "../common/joysoundParser";
import AdhocLyrics from "./AdhocLyrics";
import JoysoundRenderer from "./JoysoundRenderer";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import useSongPlayer, { type Announcement } from "./useSongPlayer";
import KarafriendsAudio from "./webAudio";

// The video, with the song's lyrics or piano roll over it.
function Player(props: {
  mics: InputDevice[];
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
  announce: (announcement: Announcement) => void;
  avOffsetMs: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const { overlay, pitchShiftSemis } = useSongPlayer({
    videoRef,
    trackRef,
    audio: props.audio,
    announce: props.announce,
  });

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
      {overlay?.kind === "dam" ? (
        <PianoRoll
          scoringData={overlay.scoringData}
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
