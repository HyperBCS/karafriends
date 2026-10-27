import React, { useEffect, useRef } from "react";
import YouTubePlayer from "youtube-player";

import { useApiQuery } from "../../../common/apiQueries";
import { t } from "../../i18n";
import * as styles from "../../pages/SongPage.module.scss";
import { withLoader } from "../Loader";
import { InlineError } from "../ui";
import VideoMetadata from "../VideoMetadata";

interface Props {
  videoId: string;
  // Called with the video's ID once its details came back.
  setYoutubeVideoId: (videoId: string) => void;
}

// The YouTube video picked to play behind a Joysound song's lyrics.
const JoysoundYouTubeInfo = ({ videoId, setYoutubeVideoId }: Props) => {
  const playerRef = useRef<ReturnType<typeof YouTubePlayer> | null>(null);
  const videoInfo = useApiQuery("youtubeInfo", { videoId });

  useEffect(() => {
    if (playerRef.current == null) {
      playerRef.current = YouTubePlayer("youtube-player", { videoId });
    } else {
      playerRef.current.loadVideoById(videoId);
      playerRef.current.stopVideo();
    }

    if (videoId && videoInfo.ok) {
      setYoutubeVideoId(videoId);
    }
  }, [videoId]);

  return (
    <>
      <div className={styles.video} hidden={!videoInfo.ok}>
        <div id="youtube-player" />
      </div>
      {videoInfo.ok ? (
        <VideoMetadata
          videoSource="youtube"
          videoInfo={videoInfo.info}
          heading={false}
        />
      ) : (
        <InlineError>
          {t("video.infoFailed", { reason: videoInfo.reason })}
        </InlineError>
      )}
    </>
  );
};

export default withLoader(JoysoundYouTubeInfo);
