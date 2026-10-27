import React, { useState } from "react";
import { useParams } from "react-router";

import ArtistSearchResults from "../components/ArtistSearchResults";
import DebouncedInput from "../components/DebouncedInput";
import SearchFormWrapper from "../components/SearchFormWrapper";
import { t } from "../i18n";

type ArtistSearchParams = {
  query: string;
};

const ArtistSearchPage = () => {
  const params = useParams<ArtistSearchParams>();
  const [query, setQuery] = useState<string | null>(params.query || null);

  return (
    <SearchFormWrapper>
      <h2>{t("search.byArtistName")}</h2>
      <DebouncedInput
        period={500}
        placeholder={t("search.placeholder")}
        onChange={(e) => {
          setQuery(e.target.value === "" ? null : e.target.value);
          history.replaceState({}, "", `#/search/artist/${e.target.value}`);
        }}
        defaultValue={params.query}
      />
      <ArtistSearchResults query={query} />
    </SearchFormWrapper>
  );
};

export default ArtistSearchPage;
