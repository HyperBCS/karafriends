import React from "react";
import { Link } from "react-router";

import type { DamArtist } from "../../../common/api";
import { ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./ArtistSearchResults.module.scss";

const ArtistSearchResultsItem = ({
  id,
  name,
  nameYomi,
  songCount,
}: DamArtist) => (
  <Link to={`/artist/${id}`}>
    <ListItem>
      <WeebText bold text={name} yomi={nameYomi} />
      <span className={styles.songCount}>
        {songCount} {songCount === 1 ? "song" : "songs"}
      </span>
    </ListItem>
  </Link>
);

export default ArtistSearchResultsItem;
