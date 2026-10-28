import formatDuration from "format-duration";
import React, { useState } from "react";

import type { SharedQueueItem } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { useApiMutation } from "../../../common/apiQueries";
import useOptimisticValue from "../../../common/hooks/useOptimisticValue";
import useQueue, { withETAs } from "../../../common/hooks/useQueue";
import { t } from "../../i18n";
import { MdClose, MdDragIndicator, MdVerticalAlignTop } from "../../icons";
import songLink, { sourceName } from "../../songLink";
import { EmptyState, IconButton, InlineError, List, ListRow } from "../ui";
import WithReading from "../WithReading";
import * as styles from "./NowPlayingSheet.module.scss";
import useDragReorder from "./useDragReorder";

// The grip a queued row is dragged by: Material Design's drag indicator,
// copied from react-icons 5.7.0 as the icons in ../../icons are.

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
  isAdmin: boolean;
  onMoveToTop: () => void;
  // The drag handle's props (useDragReorder), shown to an admin.
  handleProps: ReturnType<ReturnType<typeof useDragReorder>>;
}

// A queued song. Tapping it shows who queued it and what this phone may do
// with it: remove it (its singer, or an admin; anyone outside supervised
// mode), and for an admin, move it to the top. An admin also drags it by
// its handle.
const QueueRow = ({
  item,
  eta,
  index,
  isAdmin,
  onMoveToTop,
  handleProps,
}: RowProps) => {
  const [expanded, setExpanded] = useState(false);
  const supervisedMode = useLiveState(
    (state) => state?.config.supervisedMode ?? false,
  );
  const removeSong = useApiMutation("removeSong", {
    onError: (err) => console.error("Couldn't remove the song:", err),
  });

  // What the server allows (removeSong in src/main/api.ts).
  const canRemove = !supervisedMode || isAdmin || item.isMine;
  const nickname = nicknameOf(item);
  const queuedBy = t("queue.queuedBy", { nickname });
  const song = { songId: item.songId, timestamp: item.timestamp };

  const actions = (
    <>
      {isAdmin && (
        <IconButton
          label={t("queue.moveToTop")}
          icon={<MdVerticalAlignTop />}
          disabled={index === 0}
          onClick={onMoveToTop}
        />
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
      trailing={
        <>
          {expanded ? actions : `+${formatDuration(eta * 1000)}`}
          {isAdmin && (
            <IconButton
              label={t("queue.dragToReorder")}
              icon={<MdDragIndicator />}
              className={styles.handle}
              {...handleProps}
            />
          )}
        </>
      }
    />
  );
};

// The current song (accented, a link to its page: for adhoc lyrics, its
// singer's controls), then the queue with each song's wait. An admin's
// moves show at once, until the live state has them (or the server says
// why not, and the queue goes back).
const QueueList = () => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const [queue, setPending, clearPending] = useOptimisticValue(useQueue());
  const isAdmin = useIsAdmin() === true;
  const [moveError, setMoveError] = useState<string | null>(null);
  const moveSong = useApiMutation("moveSong", {
    onSuccess: ({ ok }) => {
      // Gone from the queue meanwhile: nothing moved.
      if (!ok) clearPending();
    },
    onError: (err) => {
      clearPending();
      setMoveError(err.message);
    },
  });

  const move = (from: number, to: number) => {
    const items = queue.map(([item]) => item);
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setPending(withETAs(currentSong, items));
    setMoveError(null);
    moveSong.mutate({
      songId: item.songId,
      timestamp: item.timestamp,
      toIndex: to,
    });
  };
  const handleProps = useDragReorder(queue.length, move);

  return (
    <>
      {moveError && (
        <InlineError>
          {t("queue.moveFailed", { reason: moveError })}
        </InlineError>
      )}
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
              isAdmin={isAdmin}
              onMoveToTop={() => move(index, 0)}
              handleProps={handleProps(index)}
            />
          ))}
        </List>
      )}
      {queue.length === 0 && <EmptyState>{t("queue.empty")}</EmptyState>}
    </>
  );
};

export default QueueList;
