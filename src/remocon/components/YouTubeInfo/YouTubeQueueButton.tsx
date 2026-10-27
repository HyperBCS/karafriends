import React from "react";

import type { YoutubeVideoInfo } from "../../../common/api";
import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import useQueueSong from "../../hooks/useQueueSong";
import Button from "../Button";

interface Props {
  videoId: string;
  videoInfo: YoutubeVideoInfo;
  adhocSongLyrics: string | null;
  selectedCaption: string | null;
}

const YouTubeQueueButton = ({
  videoId,
  videoInfo,
  adhocSongLyrics,
  selectedCaption,
}: Props) => {
  const defaultText = "Queue video";
  const [text, setText] = useDownloadButtonText(defaultText, {
    kind: "youtube",
    songId: videoId,
    suffix: null,
  });
  const { queueSong } = useQueueSong(setText, () => DOWNLOADING);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setText(WAITING_FOR_SERVER);
    queueSong(
      {
        kind: "youtube",
        songId: videoId,
        name: videoInfo.title,
        artistName: videoInfo.author,
        playtime: videoInfo.lengthSeconds,
        adhocLyrics: adhocSongLyrics,
        captionCode: selectedCaption || null,
        gainValue: videoInfo.gainValue,
      },
      e,
    );
  };

  return (
    <Button disabled={text !== defaultText} onClick={onClick}>
      {text}
    </Button>
  );
};

export default YouTubeQueueButton;
