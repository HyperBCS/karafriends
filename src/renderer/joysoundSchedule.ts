// When JoysoundRenderer draws each part of a Joysound song, and when it
// holds the part's textures. Times are the telop's milliseconds; places are
// in its 720×480 space unless they say px.
import type {
  JoysoundLyricsBlock,
  JoysoundMetadata,
} from "../common/joysoundParser";

// A block's two textures (before and after the wipe) are drawn this long
// before it fades in, so a 60-line song holds the few blocks around now, not
// all of them (at 4K each block is about 12 MB of texture).
export const TEXTURE_LEAD_MS = 1000;

export function blockOnScreen(block: JoysoundLyricsBlock, time: number) {
  return time >= block.fadeinTime && time < block.fadeoutTime;
}

// Never, for a block the timeline never shows (its times stay -1).
export function blockTexturesWanted(block: JoysoundLyricsBlock, time: number) {
  return (
    block.fadeoutTime > block.fadeinTime &&
    time >= block.fadeinTime - TEXTURE_LEAD_MS &&
    time < block.fadeoutTime
  );
}

// The title card shows from the start until the telop's title event.
export function titleOnScreen(metadata: JoysoundMetadata, time: number) {
  return time < metadata.fadeoutTime;
}

// Where the block's wipe is, in telop units.
export function getScrollXPos(
  lyricsBlock: JoysoundLyricsBlock,
  refreshTime: number,
): number {
  let xOff = 0;

  // XXX: This is a hack to handle edge cases where romaji text is off frame.
  if (
    lyricsBlock.scrollEvents[0] &&
    refreshTime < lyricsBlock.scrollEvents[0].time
  ) {
    return 0;
  }

  for (let i = 0; i < lyricsBlock.scrollEvents.length; i++) {
    const currScrollEvent = lyricsBlock.scrollEvents[i];

    if (refreshTime < currScrollEvent.time) {
      break;
    }

    let nextScrollEvent = null;

    if (i < lyricsBlock.scrollEvents.length - 1) {
      nextScrollEvent = lyricsBlock.scrollEvents[i + 1];
    }

    if (!nextScrollEvent || refreshTime < nextScrollEvent.time) {
      xOff +=
        (currScrollEvent.speed * (refreshTime - currScrollEvent.time)) / 1000;
    } else {
      xOff +=
        (currScrollEvent.speed *
          (nextScrollEvent.time - currScrollEvent.time)) /
        1000;
    }
  }

  return lyricsBlock.xPos + xOff;
}

// The wipe's edge in device pixels (expandX of them to a telop unit), whole,
// so it moves as smoothly as the screen allows rather than in steps of a
// telop unit (2.7 px at 1080p, 5.3 px at 4K).
export function wipeEdgePx(
  lyricsBlock: JoysoundLyricsBlock,
  refreshTime: number,
  expandX: number,
): number {
  return Math.floor(getScrollXPos(lyricsBlock, refreshTime) * expandX);
}

// The pitch bars' band: PianoRoll.css's .pianoRollRoll, top 5%, height 30%
// of the same 16:9 box, as a fraction of the height.
export const PITCH_BAND_BOTTOM = 0.35;

// The title card's y, as drawTextToCanvas takes it: the text starts a
// padding (and a stroke) below. Centred, unless the pitch bars show: then
// below their band, as far as the card still fits above the bottom edge.
export function titleCardTop(
  screenHeight: number,
  contentHeight: number,
  padding: number,
  clearPitchBand: boolean,
): number {
  const centred = (screenHeight - contentHeight) / 2 - padding;
  if (!clearPitchBand) return centred;
  const belowBand = screenHeight * PITCH_BAND_BOTTOM;
  const lowest = screenHeight - contentHeight - padding * 2;
  return Math.max(centred, Math.min(belowBand, lowest));
}
