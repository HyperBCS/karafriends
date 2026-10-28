import formatDuration from "format-duration";
import React from "react";

import type { VideoInfo } from "../../common/api";
import { countKey, t, useLanguage } from "../i18n";
import * as styles from "../pages/SongPage.module.scss";

interface Props {
  videoSource: "youtube" | "niconico";
  videoInfo: Pick<
    VideoInfo,
    "author" | "channelId" | "lengthSeconds" | "title" | "viewCount"
  >;
  // The title as the page's heading; a background video's is a line.
  heading?: boolean;
}

// YouTube leaves a count out now and then (null over JSON): the line
// then leaves it out too.
const known = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

// A video's title, channel, views and length.
const VideoMetadata = ({ videoSource, videoInfo, heading = true }: Props) => {
  const { language } = useLanguage();
  const channelUrl =
    videoSource === "youtube"
      ? `https://www.youtube.com/channel/${videoInfo.channelId}`
      : `https://www.nicovideo.jp/user/${videoInfo.channelId}`;
  const Title = heading ? "h2" : "p";
  const { lengthSeconds, viewCount } = videoInfo;

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
        {[
          t(videoSource === "youtube" ? "source.youtube" : "source.niconico"),
          known(lengthSeconds) && formatDuration(lengthSeconds * 1000),
          known(viewCount) &&
            t(countKey("video.views", viewCount), {
              count: viewCount.toLocaleString(language),
            }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
};

export default VideoMetadata;
