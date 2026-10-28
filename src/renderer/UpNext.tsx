import formatDuration from "format-duration";
import React from "react";

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

// The queue after the current song: rows on the idle screen (none when it's
// empty), or one line along the bottom while a song plays.
export default function UpNext({ layout }: { layout: "rows" | "strip" }) {
  const queue = useQueue();
  if (queue.length === 0 && layout === "rows") return null;
  return (
    <section className={`upNext upNext-${layout}`} aria-labelledby="upNext">
      <h2 id="upNext" className="upNextHeading">
        Up next
      </h2>
      {queue.length === 0 ? (
        <p className="upNextEmpty">Nothing queued</p>
      ) : null}
      <ol className="upNextList" role="list" aria-label="Queue">
        {queue.map(([item, eta]) => (
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
    </section>
  );
}
