import React from "react";
import { Link } from "react-router";

import type { JoysoundArtist } from "../../../common/api";
import { ListItem } from "../List";

const JoysoundArtistSearchResultsItem = ({ id, name }: JoysoundArtist) => (
  <Link to={`/joysoundArtist/${id}`}>
    <ListItem>
      <strong>{name}</strong>
    </ListItem>
  </Link>
);

export default JoysoundArtistSearchResultsItem;
