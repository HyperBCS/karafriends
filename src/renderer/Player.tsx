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
        <track ref={trackRef} kind="subtitles" default />
      </video>
      {overlay?.kind === "youtube" && overlay.adhocLyrics ? (
        <AdhocLyrics />
      ) : null}
    </div>
  );
}

export default Player;
