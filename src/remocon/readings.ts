import { isRomaji, toHiragana, toKatakana, toRomaji } from "wanakana";

import { normalize } from "./rank";

// How this phone shows song titles and artists (the profile's Readings): as
// written, or in place of that, the kana reading DAM gives, or that reading
// in romaji. Kept in localStorage ("readings"); "written" until the guest
// picks, and for a choice this version no longer has (an older "both").
export type Readings = "written" | "kana" | "romaji";
export const READINGS: readonly Readings[] = ["written", "kana", "romaji"];
export const READINGS_KEY = "readings";

export function pickReadings(saved: string | null): Readings {
  return READINGS.includes(saved as Readings) ? (saved as Readings) : "written";
}

// What to show instead of a title or an artist's name, given its kana
// reading: the kana, or the romaji. Null when it shows as written: as
// written, no reading (Joysound gives none), a name already in Latin
// letters, or kana that only repeat a name written in kana. The kana are
// hiragana, as furigana are: DAM's search gives hiragana, its song details
// katakana.
export function reading(
  written: string,
  yomi: string | undefined,
  mode: Readings,
): string | null {
  if (mode === "written" || !yomi?.trim()) return null;
  if (isRomaji(written.normalize("NFKC"))) return null;
  if (mode === "kana") {
    return normalize(yomi) === normalize(written)
      ? null
      : toHiragana(yomi, { convertLongVowelMark: false, passRomaji: true });
  }
  // From katakana, so a long vowel mark doubles the vowel (さんたくろーす:
  // santakuroosu, not santakuro-su).
  return toRomaji(toKatakana(yomi));
}
