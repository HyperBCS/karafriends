import React from "react";

import type { SharedQueueItem } from "../../common/api";
import { usePagedApiQuery } from "../../common/apiQueries";
import { withLoader } from "../components/Loader";
import MoreButton from "../components/MoreButton";
import { EmptyState, List, ListRow } from "../components/ui";
import { t, useLanguage } from "../i18n";
import songLink, { sourceName } from "../songLink";
import * as styles from "./HistoryPage.module.scss";

// Tells history entries apart: a song may have been sung more than once.
const historyKey = (song: SharedQueueItem) =>
  `${song.kind}_${song.songId}_${song.timestamp}`;

// The songs sung so far, newest first: when, and who queued each. Tapping
// one opens its page, to queue it again.
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
            title={song.name}
            subtitle={song.artistName}
            source={sourceName(song.kind)}
            to={songLink(song)}
            trailing={
              <span className={styles.when}>
                <time dateTime={new Date(Number(song.timestamp)).toISOString()}>
                  {new Date(Number(song.timestamp)).toLocaleString(language, {
                    month: "numeric",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
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
