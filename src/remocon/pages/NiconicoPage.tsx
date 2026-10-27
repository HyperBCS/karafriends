import React from "react";
import { useParams } from "react-router";

import NiconicoInfo from "../components/NiconicoInfo";
import * as styles from "./SongPage.module.scss";

// A Niconico video's page (opened by pasting its link into the search box).
const NiconicoPage = () => {
  const { videoId } = useParams<{ videoId: string }>();
  return (
    <div className={styles.page}>
      <NiconicoInfo videoId={videoId!} />
    </div>
  );
};

export default NiconicoPage;
