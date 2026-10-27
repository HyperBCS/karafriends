import React from "react";

import { useLiveState } from "../../../common/apiClient";
import SongQueueItem from "../SongQueue/SongQueueItem";
import * as styles from "./ControlBar.module.scss";

const NowPlaying = () => {
  const currentSong = useLiveState((state) => state?.currentSong);

  return (
    <div className={styles.nowPlaying} role="region" aria-label="Now playing">
      {currentSong && (
        <SongQueueItem item={currentSong} eta={0} isCurrent={true} />
      )}
    </div>
  );
};

export default NowPlaying;
