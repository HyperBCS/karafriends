import React from "react";
import { Link } from "react-router";

import type { DamSong } from "../../../common/api";
import { ListItem } from "../List";
import WeebText from "../WeebText";

const SongSearchResultsItem = ({
  id,
  name,
  nameYomi,
  artistName,
  artistNameYomi,
}: DamSong) => (
  <Link to={`/song/${id}`}>
    <ListItem>
      <div>
        <WeebText bold text={name} yomi={nameYomi} />
      </div>
      <div>
        <WeebText text={artistName} yomi={artistNameYomi} />
      </div>
    </ListItem>
  </Link>
);

export default SongSearchResultsItem;
