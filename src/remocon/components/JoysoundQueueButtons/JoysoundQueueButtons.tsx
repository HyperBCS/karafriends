import React, { useState } from "react";

import type { JoysoundSongDetail } from "../../../common/api";
import JoysoundQueueButton from "./JoysoundQueueButton";
import * as styles from "./JoysoundQueueButtons.module.scss";

interface Props {
  song: JoysoundSongDetail;
  youtubeVideoId: string | null;
  validatedYoutubeId: string | null;
}

const JoysoundQueueButtons = ({
  song,
  youtubeVideoId,
  validatedYoutubeId,
}: Props) => {
  const [isDisabled, setIsDisabled] = useState(false);

  // A background video is set but not checked yet: wait for it.
  const waitingForVideo = Boolean(youtubeVideoId && !validatedYoutubeId);
  const videoId = waitingForVideo ? youtubeVideoId : validatedYoutubeId;

  return (
    <div className={styles.container}>
      {[false, true].map((isRomaji) => (
        <JoysoundQueueButton
          key={String(isRomaji)}
          song={song}
          youtubeVideoId={videoId}
          isRomaji={isRomaji}
          isDisabled={waitingForVideo || isDisabled}
          setDisabled={setIsDisabled}
        />
      ))}
    </div>
  );
};

export default JoysoundQueueButtons;
