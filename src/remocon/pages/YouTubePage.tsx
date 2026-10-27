import React from "react";
import { Navigate, useParams } from "react-router";

import type { SharedQueueItem } from "../../common/api";
import { useLiveState } from "../../common/apiClient";
import YouTubeInfo from "../components/YouTubeInfo";
import * as styles from "./SongPage.module.scss";

// Whether this phone's YouTube video with adhoc lyrics is playing, so its
// singer gets the lyrics controls.
export function isYouTubeVideoWithLyricsPlaying(
  currentSong: SharedQueueItem | null | undefined,
  videoId: string,
): boolean {
  return (
    currentSong?.kind === "youtube" &&
    currentSong.songId === videoId &&
    currentSong.isMine &&
    currentSong.hasAdhocLyrics
  );
}

// A YouTube video's page (opened by pasting its link into the search box).
// While its singer's video with lyrics plays, the page is the lyrics
// controls instead.
const YouTubePage = () => {
  const { videoId } = useParams<{ videoId: string }>();
  const currentSong = useLiveState((state) => state?.currentSong);

  if (isYouTubeVideoWithLyricsPlaying(currentSong, videoId!)) {
    return <Navigate to={`/adhocLyrics/${videoId}`} />;
  }
  return (
    <div className={styles.page}>
      <YouTubeInfo videoId={videoId!} />
    </div>
  );
};

export default YouTubePage;
