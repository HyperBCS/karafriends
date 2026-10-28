import { isKana, isRomaji, toHiragana, toRomaji } from "wanakana";

import { normalize } from "../common/readings";

// What a search result is ranked by: its title (or, for an artist, its
// name), the artist it's by, and the kana readings DAM gives for both.
export interface Candidate {
  name: string;
  nameYomi?: string;
  artistName?: string;
  artistNameYomi?: string;
}

interface Query {
  whole: string;
  tokens: string[];
}

// Points for an exact match, a match at the start, every word of the query
// somewhere in it, and the query somewhere in it.
const TITLE = [100, 80, 60, 50];
const ARTIST = [40, 30, 20, 10];

// The query as typed, and typed in romaji also in hiragana, so "koi" finds
// DAM's reading こい, or typed in kana also in romaji, so "よあそび" finds
// YOASOBI (Joysound gives no readings).
function queryForms(query: string): Query[] {
  const typed = query.normalize("NFKC").split(/\s+/).map(normalize);
  const forms = [typed];
  if (isRomaji(query)) forms.push(typed.map((word) => toHiragana(word)));
  else if (isKana(typed.join(""))) {
    forms.push(typed.map((word) => toRomaji(word)));
  }
  return forms
    .map((words) => words.filter(Boolean))
    .filter((words) => words.length > 0)
    .map((tokens) => ({ whole: tokens.join(""), tokens }));
}

// The best points any form of the query earns against any of the texts.
function points(queries: Query[], texts: string[], scale: number[]): number {
  let best = 0;
  for (const { whole, tokens } of queries) {
    for (const text of texts) {
      if (!text) continue;
      if (text === whole) best = Math.max(best, scale[0]);
      else if (text.startsWith(whole)) best = Math.max(best, scale[1]);
      else if (tokens.length > 1 && tokens.every((t) => text.includes(t)))
        best = Math.max(best, scale[2]);
      else if (text.includes(whole)) best = Math.max(best, scale[3]);
    }
  }
  return best;
}

function score(queries: Query[], item: Candidate): number {
  const name = normalize(item.name);
  const title = points(queries, [name, normalize(item.nameYomi ?? "")], TITLE);
  const artist = points(
    queries,
    [normalize(item.artistName ?? ""), normalize(item.artistNameYomi ?? "")],
    ARTIST,
  );
  // Shorter titles first among equal matches: "恋" before "恋愛サー
  // キュレーション". At most 5, so it never lifts a row past a step above.
  const shorter = title > 0 ? 5 / Math.max(1, name.length) : 0;
  return title + artist + shorter;
}

// Every catalog's results in one list, best match for the query first.
// Equal scores keep each catalog's own order, the catalogs taking turns.
// Nothing is grouped or dropped: a song in both catalogs is there twice.
export function rank<T extends Candidate>(query: string, lists: T[][]): T[] {
  const queries = queryForms(query);
  const turns = new Map<string, number>();
  const scored = lists.flatMap((list, source) =>
    list.map((item) => {
      const value = queries.length > 0 ? score(queries, item) : 0;
      // How many of this catalog's results came before with this score.
      const key = `${source}:${value}`;
      const turn = turns.get(key) ?? 0;
      turns.set(key, turn + 1);
      return { item, source, value, turn };
    }),
  );
  scored.sort(
    (a, b) => b.value - a.value || a.turn - b.turn || a.source - b.source,
  );
  return scored.map(({ item }) => item);
}
