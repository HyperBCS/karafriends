import React from "react";

import type { NicoVideoInfo } from "../../../common/api";
import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import useQueueSong from "../../hooks/useQueueSong";
import Button from "../Button";

interface Props {
  videoId: string;
  videoInfo: NicoVideoInfo;
}

const NiconicoQueueButton = ({ videoId, videoInfo }: Props) => {
  const defaultText = "Queue video";
  const [text, setText] = useDownloadButtonText(defaultText, {
    kind: "nico",
    songId: videoId,
    suffix: null,
  });
  const { queueSong } = useQueueSong(setText, () => DOWNLOADING);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setText(WAITING_FOR_SERVER);
    queueSong(
      {
        kind: "nico",
        songId: videoId,
        name: videoInfo.title,
        artistName: videoInfo.author,
        playtime: videoInfo.lengthSeconds,
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

export default NiconicoQueueButton;
