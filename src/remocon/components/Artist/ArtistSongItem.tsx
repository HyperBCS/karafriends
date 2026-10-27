import React from "react";
import { Link } from "react-router";

import type { DamSong } from "../../../common/api";
import { ListItem } from "../List";
import WeebText from "../WeebText";

type Props = Pick<DamSong, "id" | "name" | "nameYomi">;

const ArtistSongItem = ({ id, name, nameYomi }: Props) => (
  <Link to={`/song/${id}`}>
    <ListItem>
      <WeebText bold text={name} yomi={nameYomi} />
    </ListItem>
  </Link>
);

export default ArtistSongItem;
