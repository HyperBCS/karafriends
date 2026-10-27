import React from "react";

import useQueue from "../../../common/hooks/useQueue";
import SongQueueItem from "./SongQueueItem";
import { t } from "../../i18n";

const SongQueue = () => {
  const queue = useQueue();

  return (
    <div>
      {queue.map(([item, eta]) => (
        <SongQueueItem
          key={`${item.songId}_${item.timestamp}`}
          item={item}
          eta={eta}
        />
      ))}
      {queue.length === 0 && <span>{t("queue.empty")}</span>}
    </div>
  );
};

export default SongQueue;
