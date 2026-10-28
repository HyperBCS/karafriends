import React, { useState } from "react";
import { Link } from "react-router";

import { useLiveState } from "../../../common/apiClient";
import { t } from "../../i18n";
import { BsMusicPlayerFill, FaSmile } from "../../icons";
import songLink from "../../songLink";
import { IconButton, Marquee, Sheet } from "../ui";
import WithReading from "../WithReading";
import EmoteButtons from "./EmoteButtons";
import * as styles from "./NowPlayingSheet.module.scss";
import PlaybackControls from "./PlaybackControls";
import QueueList, { nicknameOf, SingerBadge, sourceOf } from "./QueueList";

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

interface NowPlayingProps {
  expanded: boolean;
  // Following the link to the song's page, which folds the sheet.
  onOpenSong: () => void;
}

// The current song, the only place it shows: a "Now playing" label, the
// title with the artist under it, and the singer on the right. Folded, it's
// text only, and a tap on it goes to the sheet's toggle. Open, the title
// and artist are a link to the song's page (for adhoc lyrics, its singer's
// controls), with the song's source by the artist, as a queue row has it.
const NowPlaying = ({ expanded, onOpenSong }: NowPlayingProps) => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  if (!currentSong) {
    return <span className={styles.nothing}>{t("sheet.nothingPlaying")}</span>;
  }

  const song = (
    <>
      <Marquee className={styles.nowTitle}>
        <WithReading text={currentSong.name} yomi={currentSong.nameYomi} />
      </Marquee>
      <span className={styles.nowSubtitle}>
        {expanded && (
          <span className={styles.source}>{sourceOf(currentSong)}</span>
        )}
        <Marquee className={styles.nowArtist}>
          <WithReading
            text={currentSong.artistName}
            yomi={currentSong.artistNameYomi}
          />
        </Marquee>
      </span>
    </>
  );

  return (
    <div className={styles.now}>
      <span className={styles.label}>{t("sheet.nowPlaying")}</span>
      <div className={styles.nowRow}>
        {expanded ? (
          <Link
            to={songLink(currentSong)}
            state={{ artistNameYomi: currentSong.artistNameYomi }}
            className={styles.nowSong}
            onClick={onOpenSong}
          >
            {song}
          </Link>
        ) : (
          <span className={styles.nowSong}>{song}</span>
        )}
        <SingerBadge nickname={nicknameOf(currentSong)} />
      </div>
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
      header={
        <NowPlaying expanded={expanded} onOpenSong={() => setExpanded(false)} />
      }
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
