import { isRomaji, toRomaji } from "wanakana";

import { normalize } from "./rank";

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
// letters. Kana that only repeat a name written in kana are left out.
export function reading(
  written: string,
  yomi: string | undefined,
  mode: Readings,
): string | null {
  if (mode === "written" || !yomi?.trim()) return null;
  if (isRomaji(written.normalize("NFKC"))) return null;
  const kana = normalize(yomi) === normalize(written) ? null : yomi;
  const romaji = toRomaji(yomi);
  const parts =
    mode === "kana" ? [kana] : mode === "romaji" ? [romaji] : [kana, romaji];
  return parts.filter(Boolean).join(" · ") || null;
}
