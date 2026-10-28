import Hls from "hls.js";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { LyricsMode, PoppedDamSong, PoppedSong } from "../common/api";
import { call, useLiveState } from "../common/apiClient";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import { lowBitrateFallback } from "./playback";
import type { ShownSong } from "./UpNext";
import type KarafriendsAudio from "./webAudio";

const POLL_INTERVAL_MS = 5 * 1000;
// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const NON_DAM_GAIN = 0.8;

// What the player draws over the video for the song playing.
export type Overlay =
  | { kind: "dam"; scoringData: readonly number[] }
  // telop: the song's .joy_02 lyrics, once loaded.
  | { kind: "joysound"; telop: ArrayBuffer | null; lyricsMode: LyricsMode }
  | { kind: "youtube"; adhocLyrics: boolean }
  | { kind: "nico" }
  | null;

// A card for the corner overlay: a song starting, queued, or one that can't
// play, with what happened under it, if anything.
export interface Announcement {
  label: string;
  song: ShownSong;
  detail?: string;
  // The current song in the accent, a problem in red, anything else grey.
  tone?: "current" | "problem";
}

// Plays the queue in the display's <video>: while nothing plays it asks for
// the next song (popSong, which only the display may call) every 5 seconds,
// and at once when the live queue stops being empty; it loads each song by
// kind, follows the live playback state (pause, restart, skip), the key and
// the guide melody level, and asks again when a song ends.
export default function useSongPlayer({
  videoRef,
  trackRef,
  audio,
  announce,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  trackRef: RefObject<HTMLTrackElement | null>;
  audio: KarafriendsAudio;
  announce: (announcement: Announcement) => void;
}) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const guideMelodyLevel = useLiveState((s) => s?.guideMelodyLevel ?? 0);
  const songVolume = useLiveState((s) => s?.songVolume ?? 100);
  const hasQueue = useLiveState((state) => (state?.queue.length ?? 0) > 0);
  // Set while waiting for the next poll; null while one is in flight or a
  // song plays.
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a popSong call is in flight: one poll at a time, so a second
  // error or end can't take a second song off the queue.
  const pollingRef = useRef(false);
  // The song playing, until the display moves on from it.
  const songRef = useRef<PoppedSong | null>(null);
  // The DAM stream, while one plays.
  const hlsRef = useRef<Hls | null>(null);

  const schedulePoll = () => {
    pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
  };

  // Takes the next song off the queue and starts it. With none, or no
  // answer, it asks again in a while. Does nothing while a poll is in
  // flight.
  const pollQueue = useEffectEvent(() => {
    songRef.current = null;
    if (pollingRef.current) return;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    pollTimeoutRef.current = null;
    pollingRef.current = true;
    call("popSong", {}).then(
      (song) => {
        pollingRef.current = false;
        startSong(song);
      },
      (err) => {
        pollingRef.current = false;
        console.error("Couldn't ask for the next song:", err);
        schedulePoll();
      },
    );
  });

  // Moves on from song, once, if it is still the one playing.
  const skipBroken = (song: PoppedSong) => {
    if (songRef.current !== song) return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    announce({
      label: "Couldn't play",
      song,
      detail: "Skipping to the next song",
      tone: "problem",
    });
    pollQueue();
  };

  // Plays the video, once its source is set, at gain.
  const play = (video: HTMLVideoElement, gain: number) => {
    audio.gain(gain);
    video.play();
  };

  // Streams a DAM song from DAM, at the bitrate popSong says, and on its
  // third buffer stall moves to the low bitrate from where it is, for the
  // rest of the song. False if it can't, and has moved on to the next song.
  const streamDam = (video: HTMLVideoElement, song: PoppedDamSong): boolean => {
    const streamingUrl =
      song.streamingUrls[song.streamingUrlIdx]?.[
        song.startWithLowBitrate ? "low" : "high"
      ];
    if (streamingUrl === undefined) {
      // Not downloaded, and DAM didn't give popSong a URL.
      skipBroken(song);
      return false;
    }
    let stalls = 0;
    // From startPosition seconds in (-1: the start).
    const load = (url: string, startPosition: number) => {
      hlsRef.current?.destroy();
      const hls = new Hls({ maxBufferLength: 90 /* seconds */, startPosition });
      hlsRef.current = hls;
      // hls.js retries the others itself.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (songRef.current !== song) return;
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          const lowUrl = lowBitrateFallback(song, ++stalls);
          if (lowUrl !== null) {
            const playing = !video.paused;
            load(lowUrl, video.currentTime);
            if (playing) video.play();
            announce({ label: "Switched to low bitrate", song });
            return;
          }
        }
        if (!data.fatal) return;
        console.error(`DAM stream failed (${data.details}), skipping the song`);
        skipBroken(song);
      });
      hls.attachMedia(video);
      hls.loadSource(url);
    };
    load(streamingUrl, -1);
    return true;
  };

  // The downloaded file if there is one (karafriends:// is a file://
  // passthrough, so a missing file fails the fetch), else DAM's stream.
  const loadDam = async (video: HTMLVideoElement, song: PoppedDamSong) => {
    setOverlay({ kind: "dam", scoringData: song.scoringData });
    const fileUrl = `karafriends://local/${song.songId}-${song.streamingUrlIdx}.mp4`;
    let downloaded = false;
    try {
      downloaded = (await fetch(fileUrl, { method: "HEAD" })).ok;
    } catch (error) {
      console.error(error);
    }
    // Skipped while asking.
    if (songRef.current !== song) return;
    if (downloaded) {
      console.log(`Using local file for ${song.songId}`);
      video.src = fileUrl;
    } else {
      // Not done downloading yet, or not downloaded at all.
      console.log(
        `Local file for ${song.songId} doesn't seem available, using remote`,
      );
      if (!streamDam(video, song)) return;
    }
    play(video, DAM_GAIN);
  };

  const loadJoysound = async (
    video: HTMLVideoElement,
    song: Extract<PoppedSong, { kind: "joysound" }>,
  ) => {
    setOverlay({ kind: "joysound", telop: null, lyricsMode: song.lyricsMode });
    const background = song.youtubeVideoId ?? "default";
    video.src = `karafriends://local/joysound-${song.songId}-${background}.mp4`;
    let telop: ArrayBuffer;
    try {
      telop = await fetch(
        `karafriends://local/joysound-${song.songId}.joy_02`,
      ).then((resp) => resp.arrayBuffer());
    } catch (error) {
      console.error(`Couldn't load the lyrics for ${song.songId}:`, error);
      skipBroken(song);
      return;
    }
    // Skipped, or the video failed, while loading.
    if (songRef.current !== song) return;
    setOverlay({ kind: "joysound", telop, lyricsMode: song.lyricsMode });
    // At the gain the previous song left, as always.
    video.play();
  };

  const loadYoutube = (
    video: HTMLVideoElement,
    song: Extract<PoppedSong, { kind: "youtube" }>,
  ) => {
    setOverlay({ kind: "youtube", adhocLyrics: song.hasAdhocLyrics });
    video.src = `karafriends://local/yt-${song.songId}.mp4`;
    if (trackRef.current && song.hasCaptions) {
      trackRef.current.default = true;
      trackRef.current.src = `karafriends://local/yt-${song.songId}.vtt`;
    }
    console.log(`Using ${song.gainValue} for gain on Youtube queue item`);
    play(video, song.gainValue);
  };

  const loadNico = (
    video: HTMLVideoElement,
    song: Extract<PoppedSong, { kind: "nico" }>,
  ) => {
    setOverlay({ kind: "nico" });
    video.src = `karafriends://local/nico-${song.songId}.mp4`;
    play(video, NON_DAM_GAIN);
  };

  const startSong = useEffectEvent((song: PoppedSong | null) => {
    const video = videoRef.current;
    if (!video) return;
    if (!song) {
      setPlaybackState("WAITING");
      schedulePoll();
      return;
    }

    // Reset the captions and the key only for a song to play; doing it on
    // every empty poll would spam the pitch-shift mutation while idle.
    if (trackRef.current) {
      trackRef.current.default = false;
      trackRef.current.src = "";
    }
    setPitchShiftSemis(0);
    audio.setJoysoundMode(song.kind === "joysound");
    hlsRef.current?.destroy();
    hlsRef.current = null;
    songRef.current = song;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      // A YouTube or Niconico song's artist is whatever the guest typed.
      ...(song.kind === "dam" || song.kind === "joysound"
        ? { artist: song.artistName }
        : {}),
    });
    announce({
      label: "Now playing",
      tone: "current",
      song,
    });
    switch (song.kind) {
      case "dam":
        void loadDam(video, song);
        break;
      case "joysound":
        void loadJoysound(video, song);
        break;
      case "youtube":
        loadYoutube(video, song);
        break;
      case "nico":
        loadNico(video, song);
        break;
    }
    setPlaybackState("PLAYING");
  });

  // Once: ask for a song now if the display is waiting, and whenever one
  // ends or can't play (a missing or broken file).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.onended = () => pollQueue();
    video.onerror = () => {
      console.error("The video failed:", video.error?.message);
      if (songRef.current) skipBroken(songRef.current);
    };
    if (playbackState === "WAITING" && pollTimeoutRef.current === null) {
      schedulePoll();
    }
    return () => {
      video.onended = null;
      video.onerror = null;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // Only on mount: the poll keeps itself going from then on.
  }, []);

  // A song queued while nothing plays starts at once, not at the next poll
  // (which stays as the fallback). Only while a poll is armed: with none,
  // one is in flight or a song plays.
  useEffect(() => {
    if (playbackState !== "WAITING" || !hasQueue) return;
    if (pollTimeoutRef.current !== null) pollQueue();
  }, [playbackState, hasQueue]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    switch (playbackState) {
      case "PAUSED":
        video.pause();
        break;
      case "PLAYING":
        video.play();
        break;
      case "RESTARTING":
        video.currentTime = 0;
        setPlaybackState("PLAYING");
        break;
      case "SKIPPING":
        // To the end, which starts the next song; a video that never loaded
        // has no end, so the next song starts here.
        if (isFinite(video.duration)) {
          video.currentTime = video.duration;
          video.play();
        } else {
          pollQueue();
        }
        break;
    }
  }, [playbackState]);

  useEffect(() => {
    audio.pitchShift(pitchShiftSemis);
  }, [audio, pitchShiftSemis]);

  useEffect(() => {
    audio.guideMelodyLevel(guideMelodyLevel);
  }, [audio, guideMelodyLevel]);

  useEffect(() => {
    audio.songVolume(songVolume / 100);
  }, [audio, songVolume]);

  // The video's sound goes through the audio graph (guide melody, gain, key
  // change). A media element gives an audio context one source, ever, so
  // it's made once per context.
  const audioCtx = useRef<AudioContext | null>(null);
  const videoAudioSrc = useRef<MediaElementAudioSourceNode | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || audioCtx.current === audio.audioContext) return;
    videoAudioSrc.current?.disconnect();
    audioCtx.current = audio.audioContext;
    videoAudioSrc.current = audio.audioContext.createMediaElementSource(video);
    videoAudioSrc.current.connect(audio.input);
  }, [audio, videoRef]);

  return { overlay, pitchShiftSemis };
}
