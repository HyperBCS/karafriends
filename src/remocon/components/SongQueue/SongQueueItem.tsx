import formatDuration from "format-duration";
import React, { useState } from "react";
import { FaYoutube } from "react-icons/fa";
import { MdClose, MdMusicVideo } from "react-icons/md";
import { SiNiconico } from "react-icons/si";
import { useNavigate } from "react-router";

import type { SharedQueueItem } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { useApiMutation } from "../../../common/apiQueries";
import { cyrb53 } from "../../../common/hash";
import useUserIdentity from "../../hooks/useUserIdentity";
import isOwnSong from "../../isOwnSong";
import songLink from "../../songLink";
import Marquee from "../Marquee";
import * as styles from "./SongQueue.module.scss";

const ICONS = {
  dam: <MdMusicVideo />,
  joysound: <MdMusicVideo />,
  youtube: <FaYoutube />,
  nico: <SiNiconico />,
};

interface Props {
  item: SharedQueueItem;
  eta: number;
  isCurrent?: boolean;
}

const SongQueueItem = ({ item, eta, isCurrent }: Props) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const removeSong = useApiMutation("removeSong", {
    onError: (err) => console.error("Couldn't remove the song:", err),
  });

  const supervisedMode = useLiveState()?.config.supervisedMode ?? false;
  const isAdmin = useIsAdmin();
  const identity = useUserIdentity();

  // What the server allows (removeSong in src/main/api.ts).
  const canRemove =
    !supervisedMode || isAdmin === true || isOwnSong(item, identity.nickname);

  const nickname = item.user.nickname || "Unknown";
  const nicknameHash = cyrb53(nickname);
  const nicknameBgColor = `hsl(${(nicknameHash % 180) + 180}, 50%, 50%)`;

  const onClick = () => navigate(songLink(item));

  const onRemove = () =>
    removeSong.mutate({ songId: item.songId, timestamp: item.timestamp });

  return (
    <div className={styles.queueItem}>
      {expanded ? (
        <div className={styles.controls}>
          <div
            className={styles.nickname}
            style={{ backgroundColor: nicknameBgColor }}
            role="button"
            aria-label={`Queued by ${nickname}`}
            aria-expanded={true}
            onClick={() => setExpanded(false)}
          >
            {nickname}
          </div>
          {!isCurrent && canRemove && (
            <div
              className={styles.remove}
              role="button"
              aria-label="Remove from queue"
              onClick={onRemove}
            >
              <MdClose />
            </div>
          )}
        </div>
      ) : (
        <div
          className={styles.initial}
          style={{ backgroundColor: nicknameBgColor }}
          role="button"
          aria-label={`Queued by ${nickname}`}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          {nickname.slice(0, 1)}
        </div>
      )}
      <div className={styles.songMeta} onClick={onClick}>
        <Marquee>
          <div className={styles.songMetaContent}>
            {ICONS[item.kind]} {item.artistName} - {item.name}
          </div>
        </Marquee>
      </div>
      {!isCurrent && <div>+{formatDuration(eta * 1000)}</div>}
    </div>
  );
};

export default SongQueueItem;
