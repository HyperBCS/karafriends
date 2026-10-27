import React from "react";
import { Link } from "react-router";

import type { SharedQueueItem } from "../../../common/api";
import songLink from "../../songLink";
import { ListItem } from "../List";
import * as styles from "./SongHistory.module.scss";

// Tells history entries apart: a song may have been sung more than once.
export const historyKey = (song: SharedQueueItem) =>
  `${song.kind}_${song.songId}_${song.timestamp}`;

interface Props {
  song: SharedQueueItem;
}

const SongHistoryItem = ({ song }: Props) => {
  const date = new Date(parseInt(song.timestamp, 10));

  return (
    <Link to={songLink(song)}>
      <ListItem>
        <div>
          <strong>{song.name}</strong>
          <span className={styles.date}>Queued by: {song.user.nickname}</span>
        </div>

        <div>
          {song.artistName}
          <span className={styles.date}>{date.toLocaleString()}</span>
        </div>
      </ListItem>
    </Link>
  );
};

export default SongHistoryItem;
