// The pitch shifter, bundled as its own script for addModule().
import phazeAudioWorkletUrl from "./audio/phazeAudioWorklet.ts?worker&url";
import { AV_OFFSETS, audioDelay } from "./playback";
import {
  type OutputContext,
  type OutputPlace,
  SongOutputKeeper,
} from "./songOutput";

// A centred channel mixed into left and right at this gain each keeps its
// loudness (-3 dB per side).
const CENTRE_TO_SIDE = 0.7;

// The vocoder's level, even at no shift: it overlap-adds 16 frames (2048
// samples, hop 128), each windowed by Hann on the way in and out, and
// divides by 16. Hann squared averages 3/8, so the frames sum to 16 * 3/8 = 6
// and come out at 6 / 16 = 0.375 (-8.5 dB). The bypass plays at that level
// too, so a song is as loud at key 0 as at any other key, and as loud as
// before the bypass. Making the vocoder up to 1 instead would raise every
// song by 8.5 dB, and a loud YouTube gain could clip.
const VOCODER_LEVEL = 0.375;

// An output the songs can play through: its device id (from
// enumerateDevices) and its name.
export interface SongOutput {
  id: string;
  label: string;
}

// The display's sound: input → [Joysound routing] → delay (the audio/video
// offset) → gain (the song's own loudness) → songVolume (the party's
// volume) → vocoder (once its worklet loads, and only while the key is
// changed; otherwise bypassGain) → speakers.
export default class KarafriendsAudio {
  private delayNode: DelayNode;
  private gainNode: GainNode;
  private songVolumeNode: GainNode;
  private bypassGain: GainNode;
  private vocoderNode: AudioWorkletNode | null;
  private semitones = 0;
  // Joysound's ogg is 3-channel: 0 left, 1 right, 2 a synthesised guide
  // melody (centre), which a stereo destination drops. While a Joysound song
  // plays, the input goes through the splitter instead: left and right as
  // they are, and the centre through guideGain into both sides. Other songs
  // don't go this way: the splitter would put a mono source (a Niconico
  // video, say) on the left only.
  private splitter: ChannelSplitterNode;
  private guideGain: GainNode;
  // Where the songs play, kept through the output going away (see
  // songOutput.ts).
  private output: SongOutputKeeper;

  audioContext: AudioContext;
  // What the video's media element source connects to, once.
  input: GainNode;

  constructor() {
    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    this.output = new SongOutputKeeper(
      this.audioContext as unknown as OutputContext,
      navigator.mediaDevices,
    );
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
    this.bypassGain.gain.value = VOCODER_LEVEL;
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

    this.vocoderNode = null;
    try {
      this.audioContext.audioWorklet
        .addModule(phazeAudioWorkletUrl)
        .then(() => {
          try {
            // Operations that might throw synchronous errors
            this.vocoderNode = new AudioWorkletNode(
              this.audioContext,
              "phase-vocoder",
            );
            this.vocoderNode.connect(this.audioContext.destination);
            this.pitchShift(this.semitones);
          } catch (error) {
            // Handle errors that occur during the audio node operations
            console.error("Error setting up audio nodes:", error);
          }
        })
        .catch((e) => {
          // Handle errors specifically related to the module loading
          console.error(
            "Could not load pitch shift audio worklet, pitch shift will not work:",
            e,
          );
        });
    } catch (e) {
      // Handle other synchronous errors
      console.error("An unexpected error occurred:", e);
    }
  }

  // The vocoder is in the chain only while the key is changed: even at no
  // shift it adds 44 ms (measured in M8, see notes/PLAN-mobile.md), so at 0
  // the song goes through bypassGain instead, at the vocoder's level.
  pitchShift(semitones: number) {
    this.semitones = semitones;
    const vocoder = this.vocoderNode;
    if (vocoder) {
      // @ts-expect-error i swear there's a .get method on this object.
      vocoder.parameters.get("pitchFactor").value = Math.pow(2, semitones / 12);
    }
    this.songVolumeNode.disconnect();
    this.songVolumeNode.connect(
      vocoder && semitones !== 0 ? vocoder : this.bypassGain,
    );
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

  // Where the songs play: an output's device id (from enumerateDevices),
  // or "" for the system default. Rejects, keeping the output before, when
  // the songs can't play there.
  setOutput(deviceId: string): Promise<void> {
    return this.output.choose(deviceId);
  }

  // The saved output, at launch: used now if it's there (else the promise
  // rejects), and whenever it's listed again.
  wantOutput(deviceId: string): Promise<void> {
    return this.output.want(deviceId);
  }

  // Whether the songs play on that output now, on the system default, or
  // silently (it went away).
  outputPlace(): OutputPlace {
    return this.output.place();
  }

  // How loud the Joysound guide melody plays, 0 to 1.
  guideMelodyLevel(level: number) {
    this.guideGain.gain.value = level * CENTRE_TO_SIDE;
  }
}
