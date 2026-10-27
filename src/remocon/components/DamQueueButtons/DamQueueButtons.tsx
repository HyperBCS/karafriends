import React from "react";

import type { DamSongDetail } from "../../../common/api";
import DamQueueButton from "./DamQueueButton";
import * as styles from "./DamQueueButtons.module.scss";

interface Props {
  song: DamSongDetail;
}

const DamQueueButtons = ({ song }: Props) => (
  <div className={styles.container}>
    {song.vocalTypes.map((vocalType, i) => (
      <DamQueueButton key={vocalType} song={song} streamingUrlIndex={i} />
    ))}
  </div>
);

export default DamQueueButtons;
