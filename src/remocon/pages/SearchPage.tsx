import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import SearchResults, {
  type SearchBy,
  type SearchSource,
} from "../components/SearchResults";
import SourceMenu from "../components/SourceMenu";
import useCatalog, { type CatalogView } from "../hooks/useCatalog";
import { List, ListRow, SegmentedControl, TextField } from "../components/ui";
import { t } from "../i18n";
import { MdSearch } from "../icons";
import songLink, { sourceName } from "../songLink";
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

// A pasted link: anything with a dot or a slash. A bare ID is only ever
// a row to tap (see SearchPage).
const isLink = (text: string) => /[./]/.test(text);

// One search box for DAM and Joysound, by title or artist, from either or
// both. A pasted YouTube or Niconico link opens that video's page; a bare
// ID gets a row above the results that opens it.
const SearchPage = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const by: SearchBy = params.get("by") === "artist" ? "artist" : "title";
  const sourceParam = params.get("source");
  const source: SearchSource =
    sourceParam === "dam" || sourceParam === "joysound" ? sourceParam : "all";

  const [text, setText] = useState(query);
  // Only the catalogs that are on are searched (before the first live
  // state, both are tried). The source menu shows when both are.
  const views = { dam: useCatalog("dam"), joysound: useCatalog("joysound") };
  const isOn = (view: CatalogView | null) => view === null || view === "on";
  const damOn = isOn(views.dam);
  const joysoundOn = isOn(views.joysound);
  const notes = (["dam", "joysound"] as const).flatMap((catalog) => {
    const view = views[catalog];
    return view === null || view === "on" ? [] : [{ catalog, view }];
  });
  const noneOn = views.dam === "off" && views.joysound === "off";

  // From the address as it is now: a render's params can be a change
  // behind (react-router renders navigations in a transition), and a choice
  // made while typing would be lost.
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

  // A video link opens its page; anything else is searched for. A bare ID
  // is searched for too: an 11-letter title ("OneLastKiss") looks just like
  // a YouTube ID, so the guest picks the video's row if that's what it was.
  const commit = () => {
    const link = isLink(text) ? videoLink(text) : null;
    if (link) {
      navigate(songLink({ kind: link.kind, songId: link.videoId }));
    } else {
      search();
    }
  };

  // While typing, a pasted link opens at once.
  useEffect(() => {
    const timer = setTimeout(commit, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const byId = query && !isLink(query) ? videoLink(query) : null;

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
        <div className={styles.options}>
          <SegmentedControl<SearchBy>
            label={t("search.byLabel")}
            hideLabel
            small
            choices={[
              { id: "title", label: t("search.title") },
              { id: "artist", label: t("search.artist") },
            ]}
            selected={by}
            onSelect={(id) => update({ by: id })}
          />
          {damOn && joysoundOn && (
            <SourceMenu
              source={source}
              onSelect={(id) => update({ source: id })}
            />
          )}
        </div>
        {noneOn ? (
          <p className={styles.catalogNote}>{t("catalog.noneOn")}</p>
        ) : (
          notes.map(({ catalog, view }) => (
            <p key={catalog} className={styles.catalogNote}>
              {t(`catalog.${view}`, { source: sourceName(catalog) })}
            </p>
          ))
        )}
      </div>
      {byId && (
        <List label={t("search.videoById")}>
          <ListRow
            title={byId.videoId}
            subtitle={t("search.videoById")}
            source={sourceName(byId.kind)}
            to={songLink({ kind: byId.kind, songId: byId.videoId })}
          />
        </List>
      )}
      {query ? (
        <SearchResults
          query={query}
          by={by}
          // A source that's off now (an old address): all that are on.
          source={
            (source === "dam" && !damOn) ||
            (source === "joysound" && !joysoundOn)
              ? "all"
              : source
          }
          damOn={damOn}
          joysoundOn={joysoundOn}
        />
      ) : (
        <p className={styles.hint}>{t("search.linkHint")}</p>
      )}
    </>
  );
};

export default SearchPage;
