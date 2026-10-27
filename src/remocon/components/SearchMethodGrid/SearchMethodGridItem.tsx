import classnames from "classnames";
import React from "react";
import { Link } from "react-router";

import {
  BsPersonSquare,
  FaYoutube,
  MdMusicVideo,
  SiNiconico,
} from "../../icons";
import * as styles from "./SearchMethodGrid.module.scss";

const backgroundIcons = {
  song: <MdMusicVideo />,
  artist: <BsPersonSquare />,
  joysoundSong: <MdMusicVideo />,
  joysoundArtist: <BsPersonSquare />,
  youtube: <FaYoutube />,
  niconico: <SiNiconico />,
};

interface Props {
  method:
    | "song"
    | "artist"
    | "joysoundSong"
    | "joysoundArtist"
    | "youtube"
    | "niconico";
  text: string;
}

const SearchMethodGridItem = ({ method, text }: Props) => (
  <div className={styles.gridItem}>
    <Link to={`/search/${method}`}>
      <div className={classnames(styles.button, styles[method])}>
        <span className={styles.icon}>{backgroundIcons[method]}</span>
        <span className={styles.text}>{text}</span>
      </div>
    </Link>
  </div>
);

export default SearchMethodGridItem;
