import React, { useState } from "react";

import useUserIdentity from "../../hooks/useUserIdentity";
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
  const userIdentity = useUserIdentity();
  const [isDisabled, setIsDisabled] = useState(false);

  if (youtubeVideoId && !validatedYoutubeId) {
    return (
      <div className={styles.container}>
        <JoysoundQueueButton
          song={song}
          youtubeVideoId={youtubeVideoId}
          userIdentity={userIdentity}
          isRomaji={false}
          isDisabled={true}
          setDisabled={setIsDisabled}
        />

        <JoysoundQueueButton
          song={song}
          youtubeVideoId={youtubeVideoId}
          userIdentity={userIdentity}
          isRomaji={true}
          isDisabled={true}
          setDisabled={setIsDisabled}
        />
      </div>
    );
  } else {
    return (
      <div className={styles.container}>
        <JoysoundQueueButton
          song={song}
          youtubeVideoId={validatedYoutubeId}
          userIdentity={userIdentity}
          isRomaji={false}
          isDisabled={isDisabled}
          setDisabled={setIsDisabled}
        />

        <JoysoundQueueButton
          song={song}
          youtubeVideoId={validatedYoutubeId}
          userIdentity={userIdentity}
          isRomaji={true}
          isDisabled={isDisabled}
          setDisabled={setIsDisabled}
        />
      </div>
    );
  }
};

export default JoysoundQueueButtons;
