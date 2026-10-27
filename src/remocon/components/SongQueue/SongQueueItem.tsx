import formatDuration from "format-duration";
import React, { useState } from "react";
import { FaYoutube } from "react-icons/fa";
import { MdClose, MdMusicVideo } from "react-icons/md";
import { SiNiconico } from "react-icons/si";
import { graphql, useMutation } from "react-relay";
import { useNavigate } from "react-router";

import type { SharedQueueItem } from "../../../common/api";
import { useIsAdmin, useLiveState } from "../../../common/apiClient";
import { cyrb53 } from "../../../common/hash";
import useUserIdentity from "../../hooks/useUserIdentity";
import isOwnSong from "../../isOwnSong";
import Marquee from "../Marquee";
import * as styles from "./SongQueue.module.scss";

const removeSongMutation = graphql`
  mutation SongQueueItemRemoveSongMutation(
    $songId: String!
    $timestamp: String!
  ) {
    removeSong(songId: $songId, timestamp: $timestamp)
  }
`;

const SONG_PAGES = {
  dam: "/song/",
  joysound: "/joysoundSong/",
  youtube: "/search/youtube/",
  nico: "/search/niconico/",
};

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
  const [commit] = useMutation(removeSongMutation);

  const supervisedMode = useLiveState()?.config.supervisedMode ?? false;
  const isAdmin = useIsAdmin();
  const identity = useUserIdentity();

  // What the server allows (removeSong in src/main/api.ts).
  const canRemove =
    !supervisedMode || isAdmin === true || isOwnSong(item, identity.nickname);

  const nickname = item.user.nickname || "Unknown";
  const nicknameHash = cyrb53(nickname);
  const nicknameBgColor = `hsl(${(nicknameHash % 180) + 180}, 50%, 50%)`;

  const onClick = () => navigate(`${SONG_PAGES[item.kind]}${item.songId}`);

  const onRemove = () => {
    commit({ variables: { songId: item.songId, timestamp: item.timestamp } });
  };

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
