import classnames from "classnames";
import React, { useEffect, useRef } from "react";

import { t } from "../i18n";
import * as styles from "./AdhocLyricsControls.module.scss";

// The height of a line, as $line-height in AdhocLyricsControls.module.scss.
const LINE_HEIGHT = 36;
// A scroll that stops for this long has come to rest.
const SETTLE_MS = 100;

interface Props {
  lyrics: readonly string[];
  selectedIndex: number;
  onSelectLine: (line: number) => void;
}

// The lyrics on a wheel, as on a phone's date picker: the line in the middle
// band is the next one to send. Swipe or scroll the wheel to pick another,
// or tap one. The wheel turns to show each new selection.
const LyricsPicker = ({ lyrics, selectedIndex, onSelectLine }: Props) => {
  const listRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;
  const hasScrolled = useRef(false);

  useEffect(() => {
    // Past the last line (it was just sent), start again from the first.
    if (selectedIndex >= lyrics.length) {
      onSelectLine(0);
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const top = selectedIndex * LINE_HEIGHT;
    if (Math.abs(list.scrollTop - top) >= 1) {
      list.scrollTo({ top, behavior: hasScrolled.current ? "smooth" : "auto" });
    }
    hasScrolled.current = true;
  }, [selectedIndex, lyrics.length]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // Once the wheel comes to rest, the line in the middle is selected.
  const onScroll = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const list = listRef.current;
      if (!list) return;
      const index = Math.min(
        lyrics.length - 1,
        Math.max(0, Math.round(list.scrollTop / LINE_HEIGHT)),
      );
      if (index !== selectedRef.current) onSelectLine(index);
    }, SETTLE_MS);
  };

  return (
    <div className={styles.lyricsPicker}>
      <div
        ref={listRef}
        className={styles.lyricsList}
        role="listbox"
        aria-label={t("lyrics.heading")}
        tabIndex={0}
        onScroll={onScroll}
      >
        {lyrics.map((line, i) => (
          <div
            key={i}
            className={classnames(styles.lyric, {
              [styles.selected]: i === selectedIndex,
            })}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelectLine(i)}
          >
            {`${i} | ${line}`}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LyricsPicker;
