import React from "react";

import { usePagedApiQuery } from "../../../common/apiQueries";
import { List } from "../List";
import { withLoader } from "../Loader";
import MoreButton from "../MoreButton";
import SongSearchResultsItem from "./SongSearchResultsItem";

const Results = withLoader(function Results({ query }: { query: string }) {
  const paged = usePagedApiQuery(
    "joysoundSearchSongs",
    { query },
    (page) => page,
    (song) => song.id,
  );

  return (
    <>
      {paged.items.length === 0 ? (
        <span>No results found</span>
      ) : (
        <List>
          {paged.items.map((song) => (
            <SongSearchResultsItem key={song.id} {...song} />
          ))}
        </List>
      )}
      <MoreButton paged={paged} />
    </>
  );
});

interface Props {
  query: string | null;
}

const SongSearchResults = ({ query }: Props) =>
  query ? <Results query={query} /> : null;

export default SongSearchResults;
