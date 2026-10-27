import React from "react";

import useUserIdentity from "../../hooks/useUserIdentity";
import type { DamSongDetail } from "../../../common/api";
import DamQueueButton from "./DamQueueButton";
import * as styles from "./DamQueueButtons.module.scss";

interface Props {
  song: DamSongDetail;
}

const DamQueueButtons = ({ song }: Props) => {
  const userIdentity = useUserIdentity();

  return (
    <div className={styles.container}>
      {song.vocalTypes.map((vocalType, i) => (
        <DamQueueButton
          key={vocalType}
          song={song}
          streamingUrlIndex={i}
          userIdentity={userIdentity}
        />
      ))}
    </div>
  );
};

export default DamQueueButtons;
