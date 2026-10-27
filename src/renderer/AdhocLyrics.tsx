import React, { JSX, useEffect, useRef, useState } from "react";
import invariant from "ts-invariant";

import type { AdhocLyricsEntry } from "../common/api";
import { useLiveState } from "../common/apiClient";

import "./AdhocLyrics.css";

const NO_LYRICS: AdhocLyricsEntry[] = [];

type LyricEntry = {
  lyric: string;
  lyricIndex: number;
  displayIndex: number;
  marginTop: number;
  isNewLyricLine: boolean;
};

function AdhocLyrics() {
  const [lyricLines, setLyricLines] = useState<LyricEntry[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The lines the singer has pushed so far, live.
  const adhocLyrics = useLiveState()?.adhocLyrics ?? NO_LYRICS;

  function handleNewLyrics(lyrics: AdhocLyricsEntry[]) {
    setLyricLines(() => {
      const newLyricsLineCount = lyrics.length;
      const newLyricEntry: LyricEntry[] = lyrics.map((lyricEntry, index) => {
        const height = getTextHeight(
          lyricEntry.lyric,
          // This must match the width specified in AdhocLyrics.css
          "4vw sans-serif",
        );

        return {
          lyric: lyricEntry.lyric,
          lyricIndex: lyricEntry.lyricIndex,
          displayIndex: index,
          // marginTop for positioning each line
          marginTop: -1 * (newLyricsLineCount - index) * height * 3.4,
          isNewLyricLine: index === newLyricsLineCount - 1,
        };
      });
      return newLyricEntry;
    });
  }

  function getTextHeight(text: string, font: string): number {
    const canvas = canvasRef.current;
    invariant(canvas);

    const context = canvas.getContext("2d");
    invariant(context);

    context.font = font;
    const metrics = context.measureText(text);

    // @ts-ignore fontBoundingBoxAscent etc. isn't supported by a lot of browsers so it's not typed, but it does work in chromium (i.e. electron)
    return metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  }

  // After render, so the canvas that measures the text is there.
  useEffect(() => handleNewLyrics(adhocLyrics), [adhocLyrics]);

  return (
    <>
      <div className="lyrics-container">
        <canvas style={{ width: "100%" }} ref={canvasRef} />
        {lyricLines.map((lyricEntry) => {
          const wrapLyricElement = (wrappedElement: JSX.Element) => (
            <div
              className="entry-container"
              key={lyricEntry.displayIndex}
              style={{
                width: "calc(100% - 128px)",
                textAlign: "center",
                lineHeight: "1.25em",
                marginLeft: "32px",
                marginTop: lyricEntry.marginTop + 64,
              }}
            >
              {wrappedElement}
            </div>
          );
          let lyricElement: JSX.Element;
          if (lyricEntry.isNewLyricLine) {
            lyricElement = (
              <div className="lyric-fade-in">{lyricEntry.lyric}</div>
            );
            return wrapLyricElement(lyricElement);
          } else {
            lyricElement = <>{lyricEntry.lyric}</>;
            return wrapLyricElement(lyricElement);
          }
        })}
      </div>
    </>
  );
}

export default AdhocLyrics;
