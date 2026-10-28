// The pitch shifter, bundled as its own script for addModule().
import phazeAudioWorkletUrl from "./audio/phazeAudioWorklet.ts?worker&url";

// A centred channel mixed into left and right at this gain each keeps its
// loudness (-3 dB per side).
const CENTRE_TO_SIDE = 0.7;

// The display's sound: input → [Joysound routing] → gain → vocoder (once its
// worklet loads, and only while the key is changed) → speakers.
export default class KarafriendsAudio {
  private gainNode: GainNode;
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

  audioContext: AudioContext;
  // What the video's media element source connects to, once.
  input: GainNode;

  constructor() {
    this.audioContext = new AudioContext();
    this.input = this.audioContext.createGain();
    this.gainNode = this.audioContext.createGain();
    this.input.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    this.splitter = this.audioContext.createChannelSplitter(3);
    const merger = this.audioContext.createChannelMerger(2);
    this.guideGain = this.audioContext.createGain();
    this.guideGain.gain.value = 0;
    this.splitter.connect(merger, 0, 0);
    this.splitter.connect(merger, 1, 1);
    this.splitter.connect(this.guideGain, 2);
    this.guideGain.connect(merger, 0, 0);
    this.guideGain.connect(merger, 0, 1);
    merger.connect(this.gainNode);

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
  // shift it costs about 8.5 dB and 44 ms (measured in M8, see
  // notes/PLAN-mobile.md), so at 0 the gain goes straight to the speakers.
  pitchShift(semitones: number) {
    this.semitones = semitones;
    const vocoder = this.vocoderNode;
    if (vocoder) {
      // @ts-expect-error i swear there's a .get method on this object.
      vocoder.parameters.get("pitchFactor").value = Math.pow(2, semitones / 12);
    }
    this.gainNode.disconnect();
    this.gainNode.connect(
      vocoder && semitones !== 0 ? vocoder : this.audioContext.destination,
    );
  }

  gain(gain: number) {
    this.gainNode.gain.value = gain;
  }

  // On while a Joysound song plays: see splitter.
  setJoysoundMode(on: boolean) {
    this.input.disconnect();
    this.input.connect(on ? this.splitter : this.gainNode);
  }

  // How loud the Joysound guide melody plays, 0 to 1.
  guideMelodyLevel(level: number) {
    this.guideGain.gain.value = level * CENTRE_TO_SIDE;
  }
}
