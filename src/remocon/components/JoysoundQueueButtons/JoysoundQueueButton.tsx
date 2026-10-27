import React from "react";

import type { JoysoundSongDetail } from "../../../common/api";
import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import useQueueSong from "../../hooks/useQueueSong";
import Button from "../Button";

interface Props {
  song: JoysoundSongDetail;
  // The YouTube video to play behind the lyrics, if any.
  youtubeVideoId: string | null;
  isRomaji: boolean;
  isDisabled: boolean;
  setDisabled: (isDisabled: boolean) => void;
}

const JoysoundQueueButton = ({
  song,
  youtubeVideoId,
  isRomaji,
  isDisabled,
  setDisabled,
}: Props) => {
  const defaultText = `Queue song${isRomaji ? " (Romaji)" : ""}`;
  const videoId = youtubeVideoId || null;

  const [text, setText] = useDownloadButtonText(
    defaultText,
    { kind: "joysound", songId: song.id, suffix: videoId },
    () => setDisabled(false),
  );
  const { queueSong } = useQueueSong(setText, () => DOWNLOADING);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setDisabled(true);
    setText(WAITING_FOR_SERVER);
    queueSong(
      {
        kind: "joysound",
        songId: song.id,
        name: song.name,
        artistName: song.artistName,
        playtime: null,
        isRomaji,
        youtubeVideoId: videoId,
      },
      e,
    );
  };

  return (
    <Button disabled={isDisabled} onClick={onClick}>
      {text}
    </Button>
  );
};

export default JoysoundQueueButton;
