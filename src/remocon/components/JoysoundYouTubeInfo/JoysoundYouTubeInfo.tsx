import React, { useEffect, useRef } from "react";
import YouTubePlayer from "youtube-player";

import { useApiQuery } from "../../../common/apiQueries";
import { withLoader } from "../Loader";
import VideoMetadata from "../VideoMetadata";
import * as styles from "./JoysoundYouTubeInfo.module.scss";

interface Props {
  videoId: string;
  setYoutubeVideoId: (videoId: string) => void;
}

const JoysoundYouTubeInfo = ({ videoId, setYoutubeVideoId }: Props) => {
  const playerRef: React.MutableRefObject<ReturnType<
    typeof YouTubePlayer
  > | null> = useRef(null);
  const videoInfo = useApiQuery("youtubeInfo", { videoId });

  useEffect(() => {
    if (playerRef.current == null) {
      playerRef.current = YouTubePlayer("youtube-player", {
        videoId,
      });
    } else {
      playerRef.current.loadVideoById(videoId);
      playerRef.current.stopVideo();
    }

    if (videoId && videoInfo.ok) {
      setYoutubeVideoId(videoId);
    }
  }, [videoId]);

  return (
    <div className={styles.container}>
      <h3>Selected background video: {videoId}</h3>
      <div
        id="youtube-player"
        style={{ display: videoInfo.ok ? "block" : "none" }}
      />
      {!videoInfo.ok && (
        <p>
          Unable to get video info for the following reason: {videoInfo.reason}
        </p>
      )}
      {videoInfo.ok && (
        <VideoMetadata videoSource="youtube" videoInfo={videoInfo.info} />
      )}
    </div>
  );
};

export default withLoader(JoysoundYouTubeInfo);
