import React from "react";

import useNowPlaying from "../../hooks/useNowPlaying";
import useUserIdentity from "../../hooks/useUserIdentity";
import SongQueueItem from "../SongQueue/SongQueueItem";
import * as styles from "./ControlBar.module.scss";

const NowPlaying = () => {
  const { nickname } = useUserIdentity();
  const currentSong = useNowPlaying();

  return (
    <div className={styles.nowPlaying} role="region" aria-label="Now playing">
      {currentSong && (
        <SongQueueItem
          item={currentSong}
          eta={0}
          myNickname={nickname}
          isCurrent={true}
        />
      )}
    </div>
  );
};

export default NowPlaying;
