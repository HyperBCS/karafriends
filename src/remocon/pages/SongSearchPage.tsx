import React, { useState } from "react";
import { useParams } from "react-router";

import DebouncedInput from "../components/DebouncedInput";
import SearchFormWrapper from "../components/SearchFormWrapper";
import SongSearchResults from "../components/SongSearchResults";
import { t } from "../i18n";

type SongSearchParams = {
  query: string;
};

function SongSearch() {
  const params = useParams<SongSearchParams>();
  const [query, setQuery] = useState<string | null>(params.query || null);

  return (
    <SearchFormWrapper>
      <h2>{t("search.bySongTitle")}</h2>
      <DebouncedInput
        period={500}
        placeholder={t("search.placeholder")}
        onChange={(e) => {
          setQuery(e.target.value === "" ? null : e.target.value);
          history.replaceState({}, "", `#/search/song/${e.target.value}`);
        }}
        defaultValue={params.query}
      />
      <SongSearchResults query={query} />
    </SearchFormWrapper>
  );
}

export default SongSearch;
