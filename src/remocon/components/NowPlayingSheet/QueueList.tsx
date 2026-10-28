import formatDuration from "format-duration";
import React, { memo, useCallback, useState } from "react";

import type { SharedQueueItem } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { useApiMutation } from "../../../common/apiQueries";
import useOptimisticValue from "../../../common/hooks/useOptimisticValue";
import useQueue, { useWait, withETAs } from "../../../common/hooks/useQueue";
import { t } from "../../i18n";
import { MdClose, MdDragIndicator, MdVerticalAlignTop } from "../../icons";
import songLink, { sourceName } from "../../songLink";
import { EmptyState, IconButton, InlineError, List, ListRow } from "../ui";
import WithReading from "../WithReading";
import * as styles from "./NowPlayingSheet.module.scss";
import useDragReorder from "./useDragReorder";

// The singer's initial, before each row.
const Initial = ({ nickname }: { nickname: string }) => (
  <span className={styles.initial} aria-hidden="true">
    {Array.from(nickname)[0]?.toUpperCase()}
  </span>
);

export const nicknameOf = (item: SharedQueueItem) =>
  item.user.nickname || t("common.unknownUser");

// Who sings the current song: the initial and the whole nickname, muted,
// at the end of the now-playing bar and the current row. The title gives
// way before it does; a very long nickname ends in an ellipsis.
export const SingerBadge = ({ nickname }: { nickname: string }) => (
  <span className={styles.singer}>
    <Initial nickname={nickname} />
    <span className={styles.singerName}>{nickname}</span>
  </span>
);

// The small label: where the song comes from, and for Joysound, how its
// lyrics show on the TV.
const sourceOf = (item: SharedQueueItem) =>
  item.kind === "joysound"
    ? `${sourceName(item.kind)} · ${t(`lyricsMode.${item.lyricsMode}`)}`
    : sourceName(item.kind);

// A queued song's wait (from useQueue(false)), counting down while the
// current song plays: the only part of a row that changes every second.
const Wait = ({ eta }: { eta: number }) => (
  <>{`+${formatDuration(useWait(eta) * 1000)}`}</>
);

interface RowProps {
  item: SharedQueueItem;
  eta: number;
  index: number;
  isAdmin: boolean;
  onMove: (from: number, to: number) => void;
  // The drag handle's props for a row (useDragReorder), shown to an admin.
  handleProps: ReturnType<typeof useDragReorder>;
}

// A queued song. Tapping it shows who queued it and what this phone may do
// with it: remove it (its singer, or an admin; anyone outside supervised
// mode), and for an admin, move it to the top. An admin also drags it by
// its handle. It renders again only when its props change.
const QueueRow = memo(function QueueRow({
  item,
  eta,
  index,
  isAdmin,
  onMove,
  handleProps,
}: RowProps) {
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
          onClick={() => onMove(index, 0)}
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
      source={sourceOf(item)}
      onPress={() => setExpanded(!expanded)}
      expanded={expanded}
      aria-label={`${item.name}, ${queuedBy}`}
      trailing={
        <>
          {expanded ? actions : <Wait eta={eta} />}
          {isAdmin && (
            <IconButton
              label={t("queue.dragToReorder")}
              icon={<MdDragIndicator />}
              className={styles.handle}
              {...handleProps(index)}
            />
          )}
        </>
      }
    />
  );
});

// The current song (accented, a link to its page: for adhoc lyrics, its
// singer's controls), then the queue with each song's wait. An admin's
// moves show at once, until the live state has them (or the server says
// why not, and the queue goes back). The order comes from useQueue(false),
// which changes only with the queue, not every second.
const QueueList = () => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const [queue, setPending, clearPending] = useOptimisticValue(useQueue(false));
  const isAdmin = useIsAdmin() === true;
  const [moveError, setMoveError] = useState<string | null>(null);
  const { mutate: moveSong } = useApiMutation("moveSong", {
    onSuccess: ({ ok }) => {
      // Gone from the queue meanwhile: nothing moved.
      if (!ok) clearPending();
    },
    onError: (err) => {
      clearPending();
      setMoveError(err.message);
    },
  });

  const move = useCallback(
    (from: number, to: number) => {
      const items = queue.map(([item]) => item);
      const [item] = items.splice(from, 1);
      items.splice(to, 0, item);
      setPending(withETAs(currentSong, items));
      setMoveError(null);
      moveSong({
        songId: item.songId,
        timestamp: item.timestamp,
        toIndex: to,
      });
    },
    [queue, currentSong, setPending, moveSong],
  );
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
              source={sourceOf(currentSong)}
              to={songLink(currentSong)}
              trailing={<SingerBadge nickname={nicknameOf(currentSong)} />}
            />
          )}
          {queue.map(([item, eta], index) => (
            <QueueRow
              key={`${item.songId}_${item.timestamp}`}
              item={item}
              eta={eta}
              index={index}
              isAdmin={isAdmin}
              onMove={move}
              handleProps={handleProps}
            />
          ))}
        </List>
      )}
      {queue.length === 0 && <EmptyState>{t("queue.empty")}</EmptyState>}
    </>
  );
};

export default QueueList;
