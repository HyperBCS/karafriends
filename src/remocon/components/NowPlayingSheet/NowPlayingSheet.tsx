import React, { useState } from "react";

import { useLiveState } from "../../../common/apiClient";
import { t } from "../../i18n";
import { BsMusicPlayerFill, FaSmile } from "../../icons";
import { IconButton, Sheet } from "../ui";
import EmoteButtons from "./EmoteButtons";
import * as styles from "./NowPlayingSheet.module.scss";
import PlaybackControls from "./PlaybackControls";
import QueueList from "./QueueList";

// A setting of the sheet's kept on the phone ("expanded", "showEmotes"),
// so it stays as it was across a reload.
function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(
    () => localStorage.getItem(key) === "true",
  );
  return [
    value,
    (next) => {
      localStorage.setItem(key, String(next));
      setValue(next);
    },
  ];
}

// The current song and its singer, always showing.
const NowPlaying = () => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  if (!currentSong) {
    return <p className={styles.nothing}>{t("sheet.nothingPlaying")}</p>;
  }
  const singer = currentSong.user.nickname || t("common.unknownUser");
  return (
    <div className={styles.now}>
      <p className={styles.nowTitle}>{currentSong.name}</p>
      <p className={styles.nowSubtitle}>
        {[currentSong.artistName, singer].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
};

// The now-playing sheet at the bottom of every screen. Expanded, it shows
// the queue, then the playback controls or the emotes.
const NowPlayingSheet = () => {
  const [expanded, setExpanded] = useStoredFlag("expanded");
  const [showEmotes, setShowEmotes] = useStoredFlag("showEmotes");

  return (
    <Sheet
      label={t("sheet.nowPlaying")}
      header={<NowPlaying />}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <section aria-label={t("queue.label")} className={styles.queue}>
        <QueueList />
      </section>
      <div className={styles.controls}>
        <IconButton
          label={showEmotes ? t("sheet.showControls") : t("sheet.showEmotes")}
          icon={showEmotes ? <BsMusicPlayerFill /> : <FaSmile />}
          onClick={() => setShowEmotes(!showEmotes)}
        />
        {showEmotes ? <EmoteButtons /> : <PlaybackControls />}
      </div>
    </Sheet>
  );
};

export default NowPlayingSheet;
