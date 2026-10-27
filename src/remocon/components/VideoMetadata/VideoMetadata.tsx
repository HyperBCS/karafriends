import formatDuration from "format-duration";
import React from "react";

import type { VideoInfo } from "../../../common/api";
import { t, useLanguage } from "../../i18n";
import * as styles from "../../pages/SongPage.module.scss";

interface Props {
  videoSource: "youtube" | "niconico";
  videoInfo: Pick<
    VideoInfo,
    "author" | "channelId" | "lengthSeconds" | "title" | "viewCount"
  >;
  // The title as the page's heading; a background video's is a line.
  heading?: boolean;
}

// A video's title, channel, views and length.
const VideoMetadata = ({ videoSource, videoInfo, heading = true }: Props) => {
  const { language } = useLanguage();
  const channelUrl =
    videoSource === "youtube"
      ? `https://www.youtube.com/channel/${videoInfo.channelId}`
      : `https://www.nicovideo.jp/user/${videoInfo.channelId}`;
  const Title = heading ? "h2" : "p";

  return (
    <div className={styles.about}>
      <Title className={styles.title}>{videoInfo.title}</Title>
      <a
        className={styles.artist}
        href={channelUrl}
        target="_blank"
        rel="noreferrer"
      >
        {videoInfo.author}
      </a>
      <p className={styles.source}>
        {t(videoSource === "youtube" ? "source.youtube" : "source.niconico")}
        {" · "}
        {formatDuration(videoInfo.lengthSeconds * 1000)}
        {" · "}
        {t("video.views", {
          count: videoInfo.viewCount.toLocaleString(language),
        })}
      </p>
    </div>
  );
};

export default VideoMetadata;
