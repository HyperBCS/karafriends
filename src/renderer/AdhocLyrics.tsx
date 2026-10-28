import React from "react";

import type { AdhocLyricsEntry } from "../common/api";
import { useLiveState } from "../common/apiClient";

import "./AdhocLyrics.css";

const NO_LYRICS: AdhocLyricsEntry[] = [];

// The lines the singer has pushed so far, live: the newest at the bottom,
// fading in, and the older ones sliding up a line each time
// (AdhocLyrics.css places each by --line, its place counted from the
// newest).
function AdhocLyrics() {
  const adhocLyrics = useLiveState((state) => state?.adhocLyrics ?? NO_LYRICS);
  const count = adhocLyrics.length;

  return (
    <div className="lyrics-container">
      {adhocLyrics.map(({ lyric }, index) => (
        <div
          // By place, so a line keeps its element as it slides up.
          key={index}
          className="entry-container"
          style={{ "--line": count - index } as React.CSSProperties}
        >
          {index === count - 1 ? (
            <div className="lyric-fade-in">{lyric}</div>
          ) : (
            lyric
          )}
        </div>
      ))}
    </div>
  );
}

export default AdhocLyrics;
