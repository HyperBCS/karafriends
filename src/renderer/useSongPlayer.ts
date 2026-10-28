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
import { isDamSample } from "../common/downloadFailure";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import { damMelody, type Melody } from "./melody";
import { lowBitrateFallback, songGain } from "./playback";
import type { ShownSong } from "./UpNext";
import type KarafriendsAudio from "./webAudio";

const POLL_INTERVAL_MS = 5 * 1000;
// How often the display tells the server where the song is, besides on
// every start, pause, stall and seek.
const POSITION_REPORT_MS = 10 * 1000;

// What the player draws over the video for the song playing.
export type Overlay =
  // melody: the pitch bars', from DAM's scoring data.
  | { kind: "dam"; melody: Melody }
  // telop: the song's .joy_02 lyrics, once loaded. file: its video, whose
  // sound holds the guide melody the pitch bars come from.
  | {
      kind: "joysound";
      songId: string;
      file: string;
      telop: ArrayBuffer | null;
      lyricsMode: LyricsMode;
    }
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
// and at once when the live queue stops being empty (a reloaded page first
// asks for the song that was playing, to play it again); it loads each song by
// kind, follows the live playback state (pause, restart, skip), the key and
// the guide melody level, tells the server where the song really is, and
// asks again when a song ends.
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
  const hasCurrentSong = useLiveState((state) => !!state?.currentSong);
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
  // True until this page's first popSong answers. That one asks to resume:
  // after a reload (a renderer crash, or F5) the server's current song is
  // the one that was playing, and it plays again from the start.
  const resumeRef = useRef(true);

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
    call("popSong", resumeRef.current ? { resume: true } : {}).then(
      (song) => {
        pollingRef.current = false;
        resumeRef.current = false;
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

  // Lets go of the song before: its stream, its overlay (the lyrics' and
  // pitch bars' draw loops and mic polls) and the video's media. Then
  // nothing draws or holds buffers behind the idle screen, and a PLAYING
  // before the next song loads can't restart the ended video.
  const release = (video: HTMLVideoElement) => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setOverlay(null);
    if (video.hasAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
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
  // passthrough, so a missing file fails the fetch), else DAM's stream. A
  // file much shorter than the song is a sample DAM sent instead of it
  // (one downloaded before the server checked): it goes, and the song
  // streams.
  const loadDam = async (video: HTMLVideoElement, song: PoppedDamSong) => {
    setOverlay({ kind: "dam", melody: damMelody(song.scoringData) });
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
      // Its length, once known (NaN if it fails: then onerror skips it).
      const duration = new Promise<number>((resolve) => {
        const known = () => resolve(video.duration);
        video.addEventListener("loadedmetadata", known, { once: true });
        video.addEventListener("error", known, { once: true });
      });
      video.src = fileUrl;
      if (song.playtime) {
        const seconds = await duration;
        if (songRef.current !== song) return;
        if (isDamSample(seconds, song.playtime)) {
          console.warn(
            `${fileUrl} is ${seconds} s long, the song ${song.playtime} s: a sample; streaming instead`,
          );
          // Off the file first: Windows can't delete a file in use.
          video.removeAttribute("src");
          video.load();
          call("clearDownload", {
            songId: song.songId,
            suffix: song.streamingUrlIdx.toString(),
          }).catch((err) => console.error(`Couldn't delete ${fileUrl}:`, err));
          if (!streamDam(video, song)) return;
        }
      }
    } else {
      // Not done downloading yet, or not downloaded at all.
      console.log(
        `Local file for ${song.songId} doesn't seem available, using remote`,
      );
      if (!streamDam(video, song)) return;
    }
    video.play();
  };

  const loadJoysound = async (
    video: HTMLVideoElement,
    song: Extract<PoppedSong, { kind: "joysound" }>,
  ) => {
    const background = song.youtubeVideoId ?? "default";
    const file = `karafriends://local/joysound-${song.songId}-${background}.mp4`;
    const overlay = {
      kind: "joysound",
      songId: song.songId,
      file,
      lyricsMode: song.lyricsMode,
    } as const;
    setOverlay({ ...overlay, telop: null });
    video.src = file;
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
    setOverlay({ ...overlay, telop });
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
    video.play();
  };

  const loadNico = (
    video: HTMLVideoElement,
    song: Extract<PoppedSong, { kind: "nico" }>,
  ) => {
    setOverlay({ kind: "nico" });
    video.src = `karafriends://local/nico-${song.songId}.mp4`;
    video.play();
  };

  const startSong = useEffectEvent((song: PoppedSong | null) => {
    const video = videoRef.current;
    if (!video) return;
    release(video);
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
    audio.gain(songGain(song));
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

  // Tells the server where the song really is, for every countdown: as it
  // loads, starts, pauses, stalls, seeks (the video's own controls) and
  // resumes, and every 10 s in case one went missing. Not the video before
  // a new song's loads (it has ended), nor one that failed.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const report = () => {
      const song = songRef.current;
      if (!song || video.ended || video.readyState < video.HAVE_METADATA) {
        return;
      }
      call("reportSongPosition", {
        songId: song.songId,
        timestamp: song.timestamp,
        position: video.currentTime,
        length: isFinite(video.duration) ? video.duration : null,
        playing: !video.paused && video.readyState >= video.HAVE_FUTURE_DATA,
      }).catch((err) => console.error("Couldn't report the position:", err));
    };
    const events = ["loadedmetadata", "playing", "pause", "waiting", "seeked"];
    for (const event of events) video.addEventListener(event, report);
    const timer = setInterval(report, POSITION_REPORT_MS);
    return () => {
      for (const event of events) video.removeEventListener(event, report);
      clearInterval(timer);
    };
  }, [videoRef]);

  // A song queued while nothing plays starts at once, not at the next poll
  // (which stays as the fallback), and so does the song a reloaded page
  // finds current. Only while a poll is armed: with none, one is in flight
  // or a song plays.
  useEffect(() => {
    const resume = resumeRef.current && hasCurrentSong;
    if (!resume && (playbackState !== "WAITING" || !hasQueue)) return;
    if (pollTimeoutRef.current !== null) pollQueue();
  }, [playbackState, hasQueue, hasCurrentSong]);

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
