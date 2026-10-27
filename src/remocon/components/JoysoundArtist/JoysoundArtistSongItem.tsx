import React from "react";
import { Link } from "react-router";

import type { JoysoundSong } from "../../../common/api";
import { ListItem } from "../List";

const JoysoundArtistSongItem = ({ id, name }: JoysoundSong) => (
  <Link to={`/joysoundSong/${id}`}>
    <ListItem>
      <strong>{name}</strong>
    </ListItem>
  </Link>
);

export default JoysoundArtistSongItem;
