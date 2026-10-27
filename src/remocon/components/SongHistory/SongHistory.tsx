import React from "react";

import { usePagedApiQuery } from "../../../common/apiQueries";
import { List } from "../List";
import { withLoader } from "../Loader";
import MoreButton from "../MoreButton";
import SongHistoryItem, { historyKey } from "./SongHistoryItem";

const History = () => {
  // The history grows as songs play, so coming back shows what was here at
  // once and then asks for the latest.
  const paged = usePagedApiQuery("history", {}, (page) => page, historyKey, {
    staleTime: 0,
  });

  return (
    <>
      {paged.items.length === 0 ? (
        <span>No history</span>
      ) : (
        <List>
          {paged.items.map((song) => (
            <SongHistoryItem key={historyKey(song)} song={song} />
          ))}
        </List>
      )}
      <MoreButton paged={paged} />
    </>
  );
};

export default withLoader(History);
