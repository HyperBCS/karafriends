import React from "react";

import type { SharedQueueItem } from "../../common/api";
import { usePagedApiQuery } from "../../common/apiQueries";
import { withLoader } from "../components/Loader";
import MoreButton from "../components/MoreButton";
import { EmptyState, List, ListRow } from "../components/ui";
import WithReading from "../components/WithReading";
import { t, useLanguage } from "../i18n";
import songLink, { sourceName } from "../songLink";
import * as styles from "./HistoryPage.module.scss";

// Tells history entries apart: a song may have been sung more than once.
const historyKey = (song: SharedQueueItem) =>
  `${song.kind}_${song.songId}_${song.timestamp}`;

// When a song was queued: the time, and the date too if not today.
function queuedAt(timestamp: number, language: string): string {
  const when = new Date(timestamp);
  // The time in one piece ("7:35 PM"): a line may break before it.
  const time = when
    .toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, " ");
  if (when.toDateString() === new Date().toDateString()) return time;
  const date = when.toLocaleDateString(language, {
    month: "numeric",
    day: "numeric",
  });
  return `${date} ${time}`;
}

// The songs sung so far, newest first: when and by whom each was queued.
// (When it was sung isn't kept, so the time says "Queued": with a long
// queue, or one reordered, it's well before, and out of order.) Tapping one
// opens its page, to queue it again.
const HistoryPage = () => {
  const { language } = useLanguage();
  // The history grows as songs play, so coming back shows what was here at
  // once and then asks for the latest.
  const paged = usePagedApiQuery("history", {}, (page) => page, historyKey, {
    staleTime: 0,
  });

  if (paged.items.length === 0) {
    return <EmptyState>{t("history.empty")}</EmptyState>;
  }
  return (
    <>
      <List label={t("history.heading")}>
        {paged.items.map((song) => (
          <ListRow
            key={historyKey(song)}
            title={<WithReading text={song.name} yomi={song.nameYomi} />}
            subtitle={
              <WithReading text={song.artistName} yomi={song.artistNameYomi} />
            }
            source={sourceName(song.kind)}
            to={songLink(song)}
            state={{ artistNameYomi: song.artistNameYomi }}
            trailing={
              <span className={styles.when}>
                <time dateTime={new Date(Number(song.timestamp)).toISOString()}>
                  {t("history.queuedAt", {
                    time: queuedAt(Number(song.timestamp), language),
                  })}
                </time>
                <span className={styles.who}>
                  {song.user.nickname || t("common.unknownUser")}
                </span>
              </span>
            }
          />
        ))}
      </List>
      <MoreButton paged={paged} />
    </>
  );
};

export default withLoader(HistoryPage);
