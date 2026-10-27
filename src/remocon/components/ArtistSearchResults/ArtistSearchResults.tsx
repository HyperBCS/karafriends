import React from "react";

import { usePagedApiQuery } from "../../../common/apiQueries";
import { List } from "../List";
import { withLoader } from "../Loader";
import MoreButton from "../MoreButton";
import ArtistSearchResultsItem from "./ArtistSearchResultsItem";

const Results = withLoader(function Results({ query }: { query: string }) {
  const paged = usePagedApiQuery(
    "damSearchArtists",
    { query },
    (page) => page,
    (artist) => artist.id,
  );

  return (
    <>
      {paged.items.length === 0 ? (
        <span>No results found</span>
      ) : (
        <List>
          {paged.items.map((artist) => (
            <ArtistSearchResultsItem key={artist.id} {...artist} />
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

const ArtistSearchResults = ({ query }: Props) =>
  query ? <Results query={query} /> : null;

export default ArtistSearchResults;
