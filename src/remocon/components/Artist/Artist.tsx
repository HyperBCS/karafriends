import React from "react";

import { usePagedApiQuery } from "../../../common/apiQueries";
import { List } from "../List";
import { withLoader } from "../Loader";
import MoreButton from "../MoreButton";
import ArtistSongItem from "./ArtistSongItem";

interface Props {
  id: string;
}

const Artist = ({ id }: Props) => {
  const paged = usePagedApiQuery(
    "damArtist",
    { id },
    (artist) => artist.songs,
    (song) => song.id,
  );
  const artist = paged.first;

  return (
    <div>
      <h2>{artist.name}</h2>
      <span>
        {artist.songCount} {artist.songCount === 1 ? "song" : "songs"}
      </span>
      <List>
        {paged.items.map((song) => (
          <ArtistSongItem key={song.id} {...song} />
        ))}
      </List>
      <MoreButton paged={paged} />
    </div>
  );
};

export default withLoader(Artist);
