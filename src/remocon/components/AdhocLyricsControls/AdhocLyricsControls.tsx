import React, { useRef, useState } from "react";
import { Navigate } from "react-router";

import { useLiveState } from "../../../common/apiClient";
import { useApiMutation, useApiQuery } from "../../../common/apiQueries";
import { songKey } from "../../../common/currentSong";
import { isYouTubeVideoWithLyricsPlaying } from "../../pages/YouTubePage";

import { withLoader } from "../Loader";
import * as styles from "./AdhocLyricsControls.module.scss";
import LyricsController from "./LyricsController";
import LyricsPicker from "./LyricsPicker";

type Props = {
  id: string;
};

function AdhocLyricsControls({ id }: Props) {
  // Undefined until the live state arrives.
  const currentSong = useLiveState((state) =>
    state === null ? undefined : state.currentSong,
  );

  const [selectedIndex, _setSelectedIndex] = useState<number>(0);
  const indexRef = useRef(selectedIndex);
  const setSelectedIndex = (index: number) => {
    indexRef.current = index;
    _setSelectedIndex(index);
  };

  // Asked for afresh on each visit: the same video queued again may come
  // with other lyrics.
  const adhocLyrics = useApiQuery(
    "adhocLyrics",
    { songId: id },
    { staleTime: 0 },
  );
  const { mutate: pushLyrics } = useApiMutation("pushAdhocLyrics", {
    onError: (err) => console.error("Couldn't show the line:", err),
  });

  if (
    !adhocLyrics?.length ||
    (currentSong !== undefined &&
      !isYouTubeVideoWithLyricsPlaying(currentSong, id))
  ) {
    // Not (or no longer) this phone's song with lyrics: back to search.
    return <Navigate replace to="/" />;
  }

  const onSendLine = () => {
    if (!currentSong) return;
    const index = indexRef.current;
    // The server has the lyrics, so the line's number is enough, with the
    // song it is for: one sent as the song ends doesn't show on the next.
    pushLyrics({ lyricIndex: index, song: songKey(currentSong) });
    setSelectedIndex(index + 1);
  };

  return (
    <div className={styles.container}>
      <div className={styles.picker}>
        <LyricsPicker
          lyrics={adhocLyrics}
          selectedIndex={selectedIndex}
          onSelectLine={setSelectedIndex}
        />
      </div>
      <LyricsController onSendLine={onSendLine} />
    </div>
  );
}

export default withLoader(AdhocLyricsControls);
