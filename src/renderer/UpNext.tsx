import formatDuration from "format-duration";
import React from "react";

import type { QueueItem } from "../common/api";
import useQueue from "../common/hooks/useQueue";
import { reading } from "../common/readings";
import "./UpNext.css";

export type ShownSong = Pick<
  QueueItem,
  "name" | "artistName" | "nameYomi" | "artistNameYomi" | "readingsMode"
> & { user: { nickname: string } };

// A song as the TV shows it, here and in the corner (Announcements): the
// title, the artist, and who queued it, each its own element. The title and
// artist are the way the queuer's phone reads them: the kana or romaji
// reading in place of the text, when there is one.
export function SongLines({ song }: { song: ShownSong }) {
  const mode = song.readingsMode ?? "written";
  const title = reading(song.name, song.nameYomi, mode) ?? song.name;
  const artist =
    song.artistName &&
    (reading(song.artistName, song.artistNameYomi, mode) ?? song.artistName);
  const initial = [...song.user.nickname][0]?.toUpperCase();
  return (
    <>
      <span className="songTitle">{title}</span>{" "}
      {artist ? <span className="songArtist">{artist}</span> : null}{" "}
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
          <li key={`${item.songId}_${item.timestamp}`} className="upNextItem">
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
