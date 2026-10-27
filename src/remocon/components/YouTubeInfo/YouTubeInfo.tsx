import React, { useEffect, useRef, useState } from "react";
import YouTubePlayer from "youtube-player";

import { useApiQuery } from "../../../common/apiQueries";
import useUserIdentity from "../../hooks/useUserIdentity";
import { withLoader } from "../Loader";
import VideoMetadata from "../VideoMetadata";
import * as styles from "./YouTubeInfo.module.scss";
import YouTubeLyricsForm from "./YouTubeLyricsForm";
import YouTubeQueueButton from "./YouTubeQueueButton";

interface Props {
  videoId: string;
}

const YouTubeInfo = ({ videoId }: Props) => {
  const userIdentity = useUserIdentity();

  const playerRef: React.MutableRefObject<ReturnType<
    typeof YouTubePlayer
  > | null> = useRef(null);
  const [adhocSongLyrics, setAdhocSongLyrics] = useState<string | null>(null);
  const [selectedCaption, setSelectedCaption] = useState<string | undefined>(
    undefined,
  );

  const videoInfo = useApiQuery("youtubeInfo", { videoId });

  useEffect(() => {
    if (playerRef.current == null) {
      playerRef.current = YouTubePlayer("youtube-player", { videoId });
    } else {
      playerRef.current.loadVideoById(videoId);
      playerRef.current.stopVideo();
    }
  }, [videoId]);

  return (
    <div className={styles.container}>
      <div id="youtube-player" />
      {!videoInfo.ok && (
        <div>
          Unable to get video info for the following reason: {videoInfo.reason}
        </div>
      )}
      {videoInfo.ok && (
        <>
          <VideoMetadata videoSource="youtube" videoInfo={videoInfo.info} />
          <YouTubeLyricsForm
            videoInfo={videoInfo.info}
            onSelectCaption={(language) => setSelectedCaption(language)}
            onAdhocLyricsChanged={(lyrics) => setAdhocSongLyrics(lyrics)}
          />
          <YouTubeQueueButton
            videoId={videoId}
            videoInfo={videoInfo.info}
            adhocSongLyrics={adhocSongLyrics}
            selectedCaption={selectedCaption || null}
            userIdentity={userIdentity}
          />
        </>
      )}
    </div>
  );
};

export default withLoader(YouTubeInfo);
