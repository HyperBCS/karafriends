import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import SearchResults, {
  type SearchBy,
  type SearchSource,
} from "../components/SearchResults";
import { List, ListRow, Tabs, TextField } from "../components/ui";
import { t } from "../i18n";
import { MdSearch } from "../icons";
import songLink from "../songLink";
import { videoLink } from "../videoLink";
import * as styles from "./SearchPage.module.scss";

// How long typing must pause before the search goes out.
const DEBOUNCE_MS = 500;

// The search screen for a query. The query, the toggle and the filter live
// in the address, so going back to the screen shows the same results.
export function searchLink(
  query: string,
  by: SearchBy,
  source: SearchSource,
): string {
  return `/?${new URLSearchParams({ q: query, by, source })}`;
}

// One search box for DAM and Joysound, by title or artist, from either or
// both. A pasted YouTube or Niconico link or ID opens that video's page.
const SearchPage = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const by: SearchBy = params.get("by") === "artist" ? "artist" : "title";
  const sourceParam = params.get("source");
  const source: SearchSource =
    sourceParam === "dam" || sourceParam === "joysound" ? sourceParam : "all";

  const [text, setText] = useState(query);

  // From the address as it is now: a render's params can be a change
  // behind (react-router renders navigations in a transition), and a tab
  // pressed while typing would be lost.
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(window.location.hash.split("?")[1]);
    for (const [key, value] of Object.entries(changes)) {
      next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const search = () => {
    if (text.trim() !== query) update({ q: text.trim() });
  };

  // A video link or ID opens its page; anything else is searched for.
  const commit = () => {
    const link = videoLink(text);
    if (link) {
      navigate(songLink({ kind: link.kind, songId: link.videoId }));
    } else {
      search();
    }
  };

  // While typing, a pasted link opens at once. A bare ID ("sm1", on its
  // way to "sm12345") opens only on Enter or on leaving the field; until
  // then it's searched for like any text.
  useEffect(() => {
    const timer = setTimeout(/[./]/.test(text) ? commit : search, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const field = document.activeElement;
    // Leaving the field commits (onBlur). It also puts the keyboard away,
    // to show the results.
    if (field instanceof HTMLElement && e.currentTarget.contains(field)) {
      field.blur();
    } else {
      commit();
    }
  };

  return (
    <>
      <div className={styles.controls}>
        <form role="search" onSubmit={onSubmit}>
          <TextField
            label={t("search.label")}
            hideLabel
            type="search"
            enterKeyHint="search"
            icon={<MdSearch />}
            placeholder={t("search.placeholder")}
            value={text}
            onValueChange={setText}
            onBlur={commit}
            clearable
          />
        </form>
        <Tabs<SearchBy>
          label={t("search.byLabel")}
          tabs={[
            { id: "title", label: t("search.title") },
            { id: "artist", label: t("search.artist") },
          ]}
          selected={by}
          onSelect={(id) => update({ by: id })}
        />
        <Tabs<SearchSource>
          label={t("search.sourceLabel")}
          tabs={[
            { id: "all", label: t("search.sourceAll") },
            { id: "dam", label: t("source.dam") },
            { id: "joysound", label: t("source.joysound") },
          ]}
          selected={source}
          onSelect={(id) => update({ source: id })}
        />
      </div>
      {query ? (
        <SearchResults query={query} by={by} source={source} />
      ) : (
        <>
          <p className={styles.hint}>{t("search.linkHint")}</p>
          <List>
            <ListRow title={t("nav.history")} to="/history" />
          </List>
        </>
      )}
    </>
  );
};

export default SearchPage;
