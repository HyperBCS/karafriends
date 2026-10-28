import { toHiragana, toKatakana, toRomaji } from "wanakana";

import { READINGS_MODES, type ReadingsMode } from "./api";

// How a query and a title are compared (the remote's search ranking), and a
// reading told from its title: NFKC (which also makes full-width letters and
// digits half-width, and half-width kana full-width), lowercase, katakana as
// hiragana, a long vowel mark after kana as that kana's vowel, and no
// spaces, punctuation or symbols. wanakana makes ー a vowel only after
// katakana, so the kana go through katakana first: らーめん and ラーメン are
// both らあめん.
export function normalize(text: string): string {
  const options = { passRomaji: true };
  const katakana = toKatakana(text.normalize("NFKC").toLowerCase(), options);
  return toHiragana(katakana, options).replace(/[\s\p{P}\p{S}]/gu, "");
}

// How this phone shows song titles and artists (the settings' Readings): as
// written, or in place of that, the kana reading DAM gives, or that reading
// in romaji. Kept in localStorage ("readings"); "written" until the guest
// picks, and for a choice this version no longer has (an older "both").
// The same choices as a queued song's readingsMode.
export const READINGS_KEY = "readings";

export function pickReadings(saved: string | null): ReadingsMode {
  return READINGS_MODES.find((mode) => mode === saved) ?? "written";
}

// Kana or kanji anywhere: a name without them (Café, LOVE☆, Don’t) is
// already in letters a guest can read, whatever symbols it has.
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// What to show instead of a title or an artist's name, given its kana
// reading: the kana, or the romaji. Null when it shows as written: as
// written, no reading (Joysound gives none), a name with no kana or kanji,
// or kana that only repeat a name written in kana. The kana are hiragana,
// as furigana are: DAM's search gives hiragana, its song details katakana.
export function reading(
  written: string,
  yomi: string | undefined,
  mode: ReadingsMode,
): string | null {
  if (mode === "written" || !yomi?.trim()) return null;
  if (!JAPANESE.test(written.normalize("NFKC"))) return null;
  if (mode === "kana") {
    return normalize(yomi) === normalize(written)
      ? null
      : toHiragana(yomi, { convertLongVowelMark: false, passRomaji: true });
  }
  // From katakana, so a long vowel mark doubles the vowel (さんたくろーす:
  // santakuroosu, not santakuro-su).
  return toRomaji(toKatakana(yomi));
}
