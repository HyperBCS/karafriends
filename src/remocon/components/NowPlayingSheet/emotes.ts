// The emoji in what a guest typed as their emotes, each once, in order. One
// emoji is one grapheme, so a flag (🇯🇵), a skin tone (👍🏽) or a joined
// emoji (👨‍👩‍👧, 🏳️‍🌈) stays one button. Firefox before 125 has no
// Intl.Segmenter: there, by code point, as before.
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

export function emojisIn(text: string): string[] {
  const graphemes =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            text,
          ),
          ({ segment }) => segment,
        )
      : Array.from(text);
  return [...new Set(graphemes.filter((grapheme) => EMOJI.test(grapheme)))];
}
