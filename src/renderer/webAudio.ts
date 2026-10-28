// The pitch shifter, bundled as its own script for addModule().
import phazeAudioWorkletUrl from "./audio/phazeAudioWorklet.ts?worker&url";
import { AV_OFFSETS, audioDelay } from "./playback";

// A centred channel mixed into left and right at this gain each keeps its
// loudness (-3 dB per side).
const CENTRE_TO_SIDE = 0.7;

// The songs' level, at key 0 and with the key changed alike: 0.375
// (-8.5 dB), what the first vocoder's overlap-add came out at, so songs are
// as loud as they have always been. The vocoder itself is now at the input's
// level; playing at 1 would raise every song by 8.5 dB, and a loud YouTube
// gain could clip.
const SONG_LEVEL = 0.375;

// The crossfade between the bypass and the vocoder when the key leaves or
// returns to 0: a setTargetAtTime time constant, so 99% done in 25 ms.
const CROSSFADE_TIME_CONSTANT = 0.005;

// An output the songs can play through: its device id (from
// enumerateDevices) and its name.
export interface SongOutput {
  id: string;
  label: string;
}

// The display's sound: input → [Joysound routing] → delay (the audio/video
// offset) → gain (the song's own loudness) → songVolume (the party's
// volume) → bypassGain at key 0, or the vocoder (once its worklet loads)
// and vocoderOutput while the key is changed → speakers.
export default class KarafriendsAudio {
  private delayNode: DelayNode;
  private gainNode: GainNode;
  private songVolumeNode: GainNode;
  private bypassGain: GainNode;
  private vocoderOutput: GainNode;
  // The vocoder's pitchFactor, once its worklet loads.
  private pitchFactor: AudioParam | null = null;
  private semitones = 0;
  // Joysound's ogg is 3-channel: 0 left, 1 right, 2 a synthesised guide
  // melody (centre), which a stereo destination drops. While a Joysound song
  // plays, the input goes through the splitter instead: left and right as
  // they are, and the centre through guideGain into both sides. Other songs
  // don't go this way: the splitter would put a mono source (a Niconico
  // video, say) on the left only.
  private splitter: ChannelSplitterNode;
  private guideGain: GainNode;

  audioContext: AudioContext;
  // What the video's media element source connects to, once.
  input: GainNode;

  constructor() {
    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    this.input = this.audioContext.createGain();
    this.delayNode = this.audioContext.createDelay(
      audioDelay(Math.max(...AV_OFFSETS)),
    );
    this.gainNode = this.audioContext.createGain();
    this.songVolumeNode = this.audioContext.createGain();
    this.input.connect(this.delayNode);
    this.delayNode.connect(this.gainNode);
    this.gainNode.connect(this.songVolumeNode);
    this.bypassGain = this.audioContext.createGain();
    this.bypassGain.gain.value = SONG_LEVEL;
    this.bypassGain.connect(this.audioContext.destination);
    this.songVolumeNode.connect(this.bypassGain);

    this.splitter = this.audioContext.createChannelSplitter(3);
    const merger = this.audioContext.createChannelMerger(2);
    this.guideGain = this.audioContext.createGain();
    this.guideGain.gain.value = 0;
    this.splitter.connect(merger, 0, 0);
    this.splitter.connect(merger, 1, 1);
    this.splitter.connect(this.guideGain, 2);
    this.guideGain.connect(merger, 0, 0);
    this.guideGain.connect(merger, 0, 1);
    merger.connect(this.delayNode);

    this.vocoderOutput = this.audioContext.createGain();
    this.vocoderOutput.gain.value = 0;
    this.vocoderOutput.connect(this.audioContext.destination);
    this.audioContext.audioWorklet
      .addModule(phazeAudioWorkletUrl)
      .then(() => {
        // Stereo in and out, always, so its buffers never change.
        const vocoder = new AudioWorkletNode(
          this.audioContext,
          "phase-vocoder",
          {
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: "explicit",
          },
        );
        const pitchFactor = vocoder.parameters.get("pitchFactor");
        if (!pitchFactor) throw new Error("the worklet has no pitchFactor");
        // Fed all along, so its window is full when the key changes. At key
        // 0 it skips the FFTs and costs a few µs a quantum.
        this.songVolumeNode.connect(vocoder);
        vocoder.connect(this.vocoderOutput);
        this.pitchFactor = pitchFactor;
        this.pitchShift(this.semitones);
      })
      .catch((e) =>
        console.error(
          "Couldn't load the pitch shift worklet; key changes won't work:",
          e,
        ),
      );
  }

  // The song is heard through the vocoder only while the key is changed:
  // even at no shift it adds 40 ms (its 2048-sample window, less a quantum),
  // so at 0 it's heard through bypassGain instead. The two are crossfaded:
  // the vocoder's window is always full, so the song doesn't drop out, though
  // it repeats (key off 0) or skips (back to 0) those 40 ms.
  pitchShift(semitones: number) {
    this.semitones = semitones;
    const pitchFactor = this.pitchFactor;
    if (!pitchFactor) return;
    pitchFactor.value = Math.pow(2, semitones / 12);
    const now = this.audioContext.currentTime;
    const shifted = semitones !== 0;
    for (const [gain, on] of [
      [this.vocoderOutput.gain, shifted],
      [this.bypassGain.gain, !shifted],
    ] as const) {
      gain.cancelScheduledValues(now);
      gain.setTargetAtTime(on ? SONG_LEVEL : 0, now, CROSSFADE_TIME_CONSTANT);
    }
  }

  // The song's own loudness, from its source.
  gain(gain: number) {
    this.gainNode.gain.value = gain;
  }

  // The party's volume for every song, 0 to 1 (the live state's
  // songVolume).
  songVolume(volume: number) {
    this.songVolumeNode.gain.value = volume;
  }

  // On while a Joysound song plays: see splitter.
  setJoysoundMode(on: boolean) {
    this.input.disconnect();
    this.input.connect(on ? this.splitter : this.delayNode);
  }

  // The display's audio/video offset in ms: a positive one delays the sound.
  avOffset(offsetMs: number) {
    this.delayNode.delayTime.value = audioDelay(offsetMs);
  }

  // What the context says the speakers add, in ms: its measured output
  // latency once it plays, else its base latency.
  latencyMs(): number {
    const context = this.audioContext;
    return Math.round(
      (context.outputLatency || context.baseLatency || 0) * 1000,
    );
  }

  // Where the songs play: an output's device id (from
  // enumerateDevices), or "" for the system default. Chromium has
  // setSinkId on AudioContext; TypeScript's DOM types don't yet.
  setOutput(deviceId: string): Promise<void> {
    const context = this.audioContext as AudioContext & {
      setSinkId(sinkId: string): Promise<void>;
    };
    return context.setSinkId(deviceId);
  }

  // How loud the Joysound guide melody plays, 0 to 1.
  guideMelodyLevel(level: number) {
    this.guideGain.gain.value = level * CENTRE_TO_SIDE;
  }
}
