import formatDuration from "format-duration";
import React, { memo, useCallback, useState } from "react";

import type { ApiInput, SharedQueueItem } from "../../../common/api";
import { call, useIsAdmin, useLiveState } from "../../../common/apiClient";
import { songKey } from "../../../common/currentSong";
import { useApiMutation } from "../../../common/apiQueries";
import useLiveSetter from "../../../common/hooks/useLiveSetter";
import useQueue, {
  type QueueEntry,
  useWait,
  withETAs,
} from "../../../common/hooks/useQueue";
import { reading } from "../../../common/readings";
import useReadings from "../../hooks/useReadings";
import { t } from "../../i18n";
import { reasonText } from "../../i18n/reasons";
import { MdClose, MdDragIndicator, MdVerticalAlignTop } from "../../icons";
import { sourceName } from "../../songLink";
import { EmptyState, IconButton, InlineError, List, ListRow } from "../ui";
import WithReading from "../WithReading";
import * as styles from "./NowPlayingSheet.module.scss";
import useDragReorder from "./useDragReorder";

// The singer's initial, before each row.
export const Initial = ({ nickname }: { nickname: string }) => (
  <span className={styles.initial} aria-hidden="true">
    {Array.from(nickname)[0]?.toUpperCase()}
  </span>
);

export const nicknameOf = (item: SharedQueueItem) =>
  item.user.nickname || t("common.unknownUser");

// Who sings the current song: the initial and the whole nickname, muted,
// at the end of the now-playing bar. The title gives way before it does; a
// very long nickname ends in an ellipsis.
export const SingerBadge = ({ nickname }: { nickname: string }) => (
  <span className={styles.singer}>
    <Initial nickname={nickname} />
    <span className={styles.singerName}>{nickname}</span>
  </span>
);

// The small label: where the song comes from, and for Joysound, how its
// lyrics show on the TV.
export const sourceOf = (item: SharedQueueItem) =>
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
  const readings = useReadings();
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
      title={<WithReading text={item.name} yomi={item.nameYomi} />}
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
      // The title as the row shows it, so "Tap koi" finds it.
      aria-label={`${reading(item.name, item.nameYomi, readings) ?? item.name}, ${queuedBy}`}
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

// The songs waiting (the sheet's "Up next"), each with its wait (the
// current song is on the now-playing bar only). An admin's moves show at once, until the
// live state has them (or the server says why not, and the queue goes
// back). The order comes from useQueue(false), which changes only with the
// queue, not every second.
const QueueList = () => {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // The queue as moved; each move goes in turn. Gone from the queue
  // meanwhile (ok false), nothing moved.
  const [queue, setQueue] = useLiveSetter(
    useQueue(false),
    (_moved: QueueEntry[], move: ApiInput<"moveSong">) =>
      call("moveSong", move).then(
        ({ ok }) => ok,
        (err: Error) => {
          setMoveError(err.message);
          throw err;
        },
      ),
    "move the song",
  );
  const isAdmin = useIsAdmin() === true;

  const move = useCallback(
    (from: number, to: number) => {
      const items = queue.map(([item]) => item);
      const [item] = items.splice(from, 1);
      items.splice(to, 0, item);
      setMoveError(null);
      // The song it now goes before, not just the index: this phone's view
      // may be a moment behind the server's queue.
      const before = items[to + 1];
      setQueue(withETAs(currentSong, items), {
        song: songKey(item),
        before: before ? songKey(before) : null,
        toIndex: to,
      });
    },
    [queue, currentSong, setQueue],
  );
  const handleProps = useDragReorder(queue.length, move);

  return (
    <>
      {moveError && (
        <InlineError>
          {t("queue.moveFailed", { reason: reasonText(moveError) })}
        </InlineError>
      )}
      {queue.length > 0 ? (
        <List label={t("queue.upNext")} plain>
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
      ) : (
        <EmptyState>{t("queue.empty")}</EmptyState>
      )}
    </>
  );
};

export default QueueList;
