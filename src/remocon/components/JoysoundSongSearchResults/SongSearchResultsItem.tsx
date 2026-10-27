import React from "react";
import { Link } from "react-router";

import type { JoysoundSong } from "../../../common/api";
import { ListItem } from "../List";

const SongSearchResultsItem = ({ id, name, artistName }: JoysoundSong) => (
  <Link to={`/joysoundSong/${id}`}>
    <ListItem>
      <div>
        <strong>{name}</strong>
      </div>
      <div>{artistName}</div>
    </ListItem>
  </Link>
);

export default SongSearchResultsItem;
