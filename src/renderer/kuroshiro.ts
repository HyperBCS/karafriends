import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import type { KuroshiroSingleton } from "../common/joysoundParser";

// Kuroshiro and kuromoji, for Joysound songs' romaji. Kuromoji's dictionary
// is 17 MB to fetch and 100 MB once inflated, on the main thread, so it
// loads on the first song that shows romaji, not at launch: a night of kana,
// DAM or YouTube songs never pays for it. Player starts it as soon as such a
// song is queued.
let loading: Promise<KuroshiroSingleton> | null = null;

export default function loadKuroshiro(): Promise<KuroshiroSingleton> {
  if (!loading) {
    const kuroshiro = new Kuroshiro();
    // static/dict, next to the renderer/ page.
    const analyzer = new KuromojiAnalyzer({ dictPath: "../dict" });
    loading = kuroshiro.init(analyzer).then(
      () => ({ kuroshiro, analyzer }),
      (error) => {
        // Try again on the next song.
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}
