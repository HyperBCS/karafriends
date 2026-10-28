import { isRomaji, toHiragana, toKatakana, toRomaji } from "wanakana";

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

// How this phone shows song titles and artists (the profile's Readings): as
// written, or with the kana reading DAM gives, that reading in romaji, or
// both. Kept in localStorage ("readings"); "written" until the guest picks.
export type Readings = "written" | "kana" | "romaji" | "both";
export const READINGS: readonly Readings[] = [
  "written",
  "kana",
  "romaji",
  "both",
];
export const READINGS_KEY = "readings";

export function pickReadings(saved: string | null): Readings {
  return READINGS.includes(saved as Readings) ? (saved as Readings) : "written";
}

// What to show with a title or an artist's name, given its kana reading:
// the kana, the romaji, or both. Null when there's nothing to add: as
// written, no reading (Joysound gives none), or a name already in Latin
// letters. Kana that only repeat a name written in kana are left out. The
// kana are hiragana, as furigana are: DAM's search gives hiragana, its song
// details katakana.
export function reading(
  written: string,
  yomi: string | undefined,
  mode: Readings,
): string | null {
  if (mode === "written" || !yomi?.trim()) return null;
  if (isRomaji(written.normalize("NFKC"))) return null;
  const kana =
    normalize(yomi) === normalize(written)
      ? null
      : toHiragana(yomi, { convertLongVowelMark: false, passRomaji: true });
  // From katakana, so a long vowel mark doubles the vowel (さんたくろーす:
  // santakuroosu, not santakuro-su).
  const romaji = toRomaji(toKatakana(yomi));
  const parts =
    mode === "kana" ? [kana] : mode === "romaji" ? [romaji] : [kana, romaji];
  return parts.filter(Boolean).join(" · ") || null;
}
