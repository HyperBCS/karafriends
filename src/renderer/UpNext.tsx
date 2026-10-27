import formatDuration from "format-duration";
import React from "react";

import useQueue from "../common/hooks/useQueue";
import "./UpNext.css";

// The queue after the current song: rows on the idle screen, or one line
// along the bottom while a song plays.
export default function UpNext({ layout }: { layout: "rows" | "strip" }) {
  const queue = useQueue();
  return (
    <section className={`upNext upNext-${layout}`} aria-labelledby="upNext">
      <h2 id="upNext" className="upNextHeading">
        Up next
      </h2>
      {queue.length === 0 && layout === "strip" ? (
        <p className="upNextEmpty">Nothing queued</p>
      ) : null}
      <ol className="upNextList" role="list" aria-label="Queue">
        {queue.map(([item, eta]) => (
          <li key={`${item.songId}_${item.timestamp}`} className="upNextItem">
            <span className="upNextTitle">{item.name}</span>
            {item.artistName ? (
              <span className="upNextArtist">{item.artistName}</span>
            ) : null}
            <span className="upNextMeta">
              {item.user.nickname} ·{" "}
              {eta === 0 ? "next" : `in ${formatDuration(eta * 1000)}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
