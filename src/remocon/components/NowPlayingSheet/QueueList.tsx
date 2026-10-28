import formatDuration from "format-duration";
import React, { useState } from "react";

import type { SharedQueueItem } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { useApiMutation } from "../../../common/apiQueries";
import useQueue from "../../../common/hooks/useQueue";
import { t } from "../../i18n";
import {
  MdArrowDownward,
  MdArrowUpward,
  MdClose,
  MdVerticalAlignTop,
} from "../../icons";
import songLink, { sourceName } from "../../songLink";
import { EmptyState, IconButton, List, ListRow } from "../ui";
import WithReading from "../WithReading";
import * as styles from "./NowPlayingSheet.module.scss";

// The singer's initial, before each row.
const Initial = ({ nickname }: { nickname: string }) => (
  <span className={styles.initial} aria-hidden="true">
    {Array.from(nickname)[0]?.toUpperCase()}
  </span>
);

const nicknameOf = (item: SharedQueueItem) =>
  item.user.nickname || t("common.unknownUser");

interface RowProps {
  item: SharedQueueItem;
  eta: number;
  index: number;
  isLast: boolean;
}

// A queued song. Tapping it shows who queued it and what this phone may do
// with it: remove it (its singer, or an admin; anyone outside supervised
// mode), and for an admin, move it.
const QueueRow = ({ item, eta, index, isLast }: RowProps) => {
  const [expanded, setExpanded] = useState(false);
  const supervisedMode = useLiveState(
    (state) => state?.config.supervisedMode ?? false,
  );
  const isAdmin = useIsAdmin() === true;
  const removeSong = useApiMutation("removeSong", {
    onError: (err) => console.error("Couldn't remove the song:", err),
  });
  const moveSong = useApiMutation("moveSong", {
    onError: (err) => console.error("Couldn't move the song:", err),
  });

  // What the server allows (removeSong in src/main/api.ts).
  const canRemove = !supervisedMode || isAdmin || item.isMine;
  const nickname = nicknameOf(item);
  const queuedBy = t("queue.queuedBy", { nickname });
  const song = { songId: item.songId, timestamp: item.timestamp };
  const move = (toIndex: number) => moveSong.mutate({ ...song, toIndex });

  const actions = (
    <>
      {isAdmin && (
        <>
          <IconButton
            label={t("queue.moveToTop")}
            icon={<MdVerticalAlignTop />}
            disabled={index === 0}
            onClick={() => move(0)}
          />
          <IconButton
            label={t("queue.moveUp")}
            icon={<MdArrowUpward />}
            disabled={index === 0}
            onClick={() => move(index - 1)}
          />
          <IconButton
            label={t("queue.moveDown")}
            icon={<MdArrowDownward />}
            disabled={isLast}
            onClick={() => move(index + 1)}
          />
        </>
      )}
      {canRemove && (
        <IconButton
          label={t("queue.remove")}
          icon={<MdClose />}
          tone="danger"
          onClick={() => removeSong.mutate(song)}
        />
      )}
    </>
  );

  return (
    <ListRow
      leading={<Initial nickname={nickname} />}
      title={<WithReading text={item.name} yomi={item.nameYomi} under />}
      subtitle={
        expanded ? (
          queuedBy
        ) : (
          <WithReading text={item.artistName} yomi={item.artistNameYomi} />
        )
      }
      source={sourceName(item.kind)}
      onPress={() => setExpanded(!expanded)}
      expanded={expanded}
      aria-label={`${item.name}, ${queuedBy}`}
      trailing={expanded ? actions : `+${formatDuration(eta * 1000)}`}
    />
  );
};

// The current song (accented, a link to its page: for adhoc lyrics, its
// singer's controls), then the queue with each song's wait.
const QueueList = () => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const queue = useQueue();

  return (
    <>
      {(currentSong || queue.length > 0) && (
        <List label={t("queue.label")}>
          {currentSong && (
            <ListRow
              current
              leading={<Initial nickname={nicknameOf(currentSong)} />}
              title={
                <WithReading
                  text={currentSong.name}
                  yomi={currentSong.nameYomi}
                  under
                />
              }
              subtitle={
                <WithReading
                  text={currentSong.artistName}
                  yomi={currentSong.artistNameYomi}
                />
              }
              source={sourceName(currentSong.kind)}
              to={songLink(currentSong)}
              trailing={t("sheet.nowPlaying")}
            />
          )}
          {queue.map(([item, eta], index) => (
            <QueueRow
              key={`${item.songId}_${item.timestamp}`}
              item={item}
              eta={eta}
              index={index}
              isLast={index === queue.length - 1}
            />
          ))}
        </List>
      )}
      {queue.length === 0 && <EmptyState>{t("queue.empty")}</EmptyState>}
    </>
  );
};

export default QueueList;
