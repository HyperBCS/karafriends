import React, { useEffect } from "react";

import { useApiQuery } from "../../common/apiQueries";
import { t } from "../i18n";
import { reasonText } from "../i18n/reasons";
import { withLoader } from "./Loader";
import { InlineError } from "./ui";
import VideoMetadata from "./VideoMetadata";
import YouTubeEmbed from "./YouTubeEmbed";

interface Props {
  videoId: string;
  // Called with the video's ID once its details came back.
  setYoutubeVideoId: (videoId: string) => void;
}

// The YouTube video picked to play behind a Joysound song's lyrics.
const JoysoundYouTubeInfo = ({ videoId, setYoutubeVideoId }: Props) => {
  const videoInfo = useApiQuery("youtubeInfo", { videoId });

  // One video per mount: JoysoundQueue keys this by the song, and changing
  // the video unmounts it first.
  useEffect(() => {
    if (videoInfo.ok) setYoutubeVideoId(videoId);
  }, [videoId]);

  return (
    <>
      {videoInfo.ok ? (
        <>
          <YouTubeEmbed videoId={videoId} />
          <VideoMetadata
            videoSource="youtube"
            videoInfo={videoInfo.info}
            heading={false}
          />
        </>
      ) : (
        <InlineError>
          {t("video.infoFailed", { reason: reasonText(videoInfo.reason) })}
        </InlineError>
      )}
    </>
  );
};

export default withLoader(JoysoundYouTubeInfo);
