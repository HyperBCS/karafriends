import formatDuration from "format-duration";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { QueueItem } from "../common/api";
import useQueue from "../common/hooks/useQueue";
import { reading } from "../common/readings";
import Marquee from "./Marquee";
import "./UpNext.css";

export type ShownSong = Pick<
  QueueItem,
  "name" | "artistName" | "nameYomi" | "artistNameYomi" | "readingsMode"
> & { user: { nickname: string } };

// A song as the TV shows it, here and in the corner (Announcements): the
// title, the artist, and who queued it, each its own element. The title and
// artist are the way the queuer's phone reads them: the kana or romaji
// reading in place of the text, when there is one; either slides when it
// doesn't fit. The singer is an initial in a circle and the nickname; Up
// next shows only the initial, and screen readers hear the nickname.
export function SongLines({ song }: { song: ShownSong }) {
  const mode = song.readingsMode ?? "written";
  const title = reading(song.name, song.nameYomi, mode) ?? song.name;
  const artist =
    song.artistName &&
    (reading(song.artistName, song.artistNameYomi, mode) ?? song.artistName);
  const initial = [...song.user.nickname][0]?.toUpperCase();
  return (
    <>
      <Marquee className="songTitle">{title}</Marquee>{" "}
      {artist ? <Marquee className="songArtist">{artist}</Marquee> : null}{" "}
      <span className="songSinger">
        {initial ? (
          <span className="songInitial" aria-hidden="true">
            {initial}
          </span>
        ) : null}{" "}
        <span className="songNickname">{song.user.nickname}</span>
      </span>
    </>
  );
}

// When a song's long title or artist in Up next first moves: 1 to 3¼ s
// after it shows, picked by when the song was queued (so it stays the same
// as the queue moves on), so songs side by side don't move in step.
function marqueeDelay(timestamp: string): string {
  return `${1 + ((Number(timestamp) || 0) % 4) * 0.75}s`;
}

// The most songs the idle screen lists; fewer when fewer fit whole (a big
// UI scale). The rest are counted under them: a long queue ran off the
// screen.
export const IDLE_ROWS = 8;

type Queue = ReturnType<typeof useQueue>;

function SongList({
  songs,
  listRef,
}: {
  songs: Queue;
  listRef?: React.Ref<HTMLOListElement>;
}) {
  return (
    <ol ref={listRef} className="upNextList" role="list" aria-label="Queue">
      {songs.map(([item, eta]) => (
        <li
          key={`${item.songId}_${item.timestamp}`}
          className="upNextItem"
          style={
            {
              "--kf-marquee-delay": marqueeDelay(item.timestamp),
            } as React.CSSProperties
          }
        >
          <SongLines song={item} />{" "}
          <span className="upNextWait">
            {eta === 0 ? "next" : `in ${formatDuration(eta * 1000)}`}
          </span>
        </li>
      ))}
    </ol>
  );
}

// The idle screen's card: "Up next" and how many songs, the first ones that
// fit whole, and how many more.
function UpNextRows({ queue }: { queue: Queue }) {
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [fit, setFit] = useState(IDLE_ROWS);
  // After each render, a song cut off at the card's foot goes: only whole
  // ones show, and the count under them takes it.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const bottom = list.getBoundingClientRect().bottom;
    const rows = [...list.children];
    const whole = rows.filter(
      (row) => row.getBoundingClientRect().bottom <= bottom + 1,
    ).length;
    if (whole < rows.length) setFit(Math.max(1, whole));
  });
  // A new size (the window's, the UI scale's: the header's height follows
  // both) may make room again, so start from the most again.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() => setFit(IDLE_ROWS));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const shown = queue.slice(0, fit);
  const more = queue.length - shown.length;
  return (
    <section className="upNext upNext-rows" aria-labelledby="upNext">
      <div ref={headerRef} className="upNextHeader">
        <h2 id="upNext" className="upNextHeading">
          Up next
        </h2>
        <span className="upNextCount">
          {queue.length === 1 ? "1 song" : `${queue.length} songs`}
        </span>
      </div>
      <div className="upNextCard">
        <SongList songs={shown} listRef={listRef} />
        {more > 0 ? <p className="upNextMore">+{more} more</p> : null}
      </div>
    </section>
  );
}

// The queue after the current song: rows on the idle screen (none when it's
// empty), or one line along the bottom while a song plays.
export default function UpNext({ layout }: { layout: "rows" | "strip" }) {
  const queue = useQueue();
  if (layout === "rows") {
    return queue.length === 0 ? null : <UpNextRows queue={queue} />;
  }
  return (
    <section className="upNext upNext-strip" aria-labelledby="upNext">
      <h2 id="upNext" className="upNextHeading">
        Up next
      </h2>
      {queue.length === 0 ? (
        <p className="upNextEmpty">Nothing queued</p>
      ) : null}
      <SongList songs={queue} />
    </section>
  );
}
