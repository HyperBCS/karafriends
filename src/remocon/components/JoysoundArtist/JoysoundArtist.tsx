import React from "react";

import { usePagedApiQuery } from "../../../common/apiQueries";
import { List } from "../List";
import { withLoader } from "../Loader";
import MoreButton from "../MoreButton";
import JoysoundArtistSongItem from "./JoysoundArtistSongItem";

interface Props {
  id: string;
}

const JoysoundArtist = ({ id }: Props) => {
  const paged = usePagedApiQuery(
    "joysoundArtistSongs",
    { id },
    (page) => page,
    (song) => song.id,
  );

  return (
    <div>
      <h2>{paged.items[0]?.artistName}</h2>
      <List>
        {paged.items.map((song) => (
          <JoysoundArtistSongItem key={song.id} {...song} />
        ))}
      </List>
      <MoreButton paged={paged} />
    </div>
  );
};

export default withLoader(JoysoundArtist);
