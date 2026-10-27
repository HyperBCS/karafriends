import formatDuration from "format-duration";
import React, { useEffect, useState } from "react";

import type { DamSongDetail, VocalType } from "../../../common/api";
import useQueueSong from "../../hooks/useQueueSong";
import Button from "../Button";

function getDefaultText(vocalType: VocalType | undefined) {
  let defaultText = "Queue song - guide vocal (unknown type)";
  switch (vocalType) {
    case "NORMAL":
      defaultText = "Queue song";
      break;
    case "GUIDE_MALE":
      defaultText = "Queue song - guide vocal (male)";
      break;
    case "GUIDE_FEMALE":
      defaultText = "Queue song - guide vocal (female)";
      break;
  }
  return defaultText;
}

interface Props {
  song: DamSongDetail;
  streamingUrlIndex: number;
}

const DamQueueButton = ({ song, streamingUrlIndex }: Props) => {
  const defaultText = getDefaultText(song.vocalTypes[streamingUrlIndex]);
  const [text, setText] = useState(defaultText);
  // A DAM song joins the queue at once (it downloads in the background).
  const { queueSong, isPending } = useQueueSong(
    setText,
    (eta) => `Estimated wait: T-${formatDuration(eta * 1000)}`,
  );

  // The ETA or error shows for a while, then the button is ready again.
  // (Only when the text changes: a timer started again on every render would
  // never go off while something else re-renders the page.)
  useEffect(() => {
    if (text === defaultText) return;
    const timeout = setTimeout(() => setText(defaultText), 2500);
    return () => clearTimeout(timeout);
  }, [text, defaultText]);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) =>
    queueSong(
      {
        kind: "dam",
        songId: song.id,
        name: song.name,
        artistName: song.artistName,
        playtime: song.playtime,
        streamingUrlIdx: streamingUrlIndex,
      },
      e,
    );

  return (
    <Button disabled={isPending || text !== defaultText} onClick={onClick}>
      {text}
    </Button>
  );
};

export default DamQueueButton;
