import { useInfiniteQuery } from "@tanstack/react-query";
import React, { memo, useMemo } from "react";

import type { Page } from "../../common/api";
import { call } from "../../common/apiClient";
import { countKey, t } from "../i18n";
import { rank } from "../rank";
import Loader from "./Loader";
import MoreButton from "./MoreButton";
import * as styles from "./SearchResults.module.scss";
import { EmptyState, InlineError, List, ListRow } from "./ui";
import WithReading from "./WithReading";

export type SearchBy = "title" | "artist";
export type SearchSource = "all" | "dam" | "joysound";
type Catalog = "dam" | "joysound";

const METHODS = {
  dam: { title: "damSearchSongs", artist: "damSearchArtists" },
  joysound: { title: "joysoundSearchSongs", artist: "joysoundSearchArtists" },
} as const;

// What the four searches answer with, as far as a row and the ranking
// need: a song (with its artist) or an artist (with DAM's song count), and
// the kana readings DAM gives.
interface Found {
  id: string;
  name: string;
  nameYomi?: string;
  artistName?: string;
  artistNameYomi?: string;
  songCount?: number;
}

const PAGES = {
  dam: { title: "/song/", artist: "/artist/" },
  joysound: { title: "/joysoundSong/", artist: "/joysoundArtist/" },
};

// One catalog's results, a page at a time. Not a suspending lookup: each
// catalog loads and fails on its own, so a host with one login (or a
// catalog that's down) still gets the other's results.
function useCatalogSearch(
  catalog: Catalog,
  by: SearchBy,
  query: string,
  enabled: boolean,
) {
  const method = METHODS[catalog][by];
  const input = { query };
  return useInfiniteQuery({
    // As usePagedApiQuery keys its lists.
    queryKey: [method, input, "paged"],
    queryFn: ({ pageParam }) =>
      call(method, { ...input, offset: pageParam }) as Promise<Page<Found>>,
    initialPageParam: 0,
    getNextPageParam: (last: Page<Found>) => last.nextOffset ?? undefined,
    enabled,
  });
}

interface Props {
  query: string;
  by: SearchBy;
  source: SearchSource;
}

// DAM's and Joysound's answers to a search in one list, best match first
// (see rank), ranked again as each page comes in. Each row says which
// catalog it's from.
const SearchResults = ({ query, by, source }: Props) => {
  const searches = {
    dam: useCatalogSearch("dam", by, query, source !== "joysound"),
    joysound: useCatalogSearch("joysound", by, query, source !== "dam"),
  };
  const catalogs = (["dam", "joysound"] as const).filter(
    (catalog) => source === "all" || source === catalog,
  );
  const sourceName = (catalog: Catalog) =>
    t(catalog === "dam" ? "source.dam" : "source.joysound");

  // Each catalog's loaded pages, without the repeats a shifting catalog
  // can put on a later page.
  // Ranked again only when a page comes in (or the query changes).
  const damPages = searches.dam.data?.pages;
  const joysoundPages = searches.joysound.data?.pages;
  const ranked = useMemo(() => {
    const pages = { dam: damPages, joysound: joysoundPages };
    const found = catalogs.map((catalog) => {
      const seen = new Set<string>();
      return (pages[catalog] ?? [])
        .flatMap((page) => page.items)
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .map((item) => ({ ...item, catalog }));
    });
    return rank(query, found);
  }, [query, source, damPages, joysoundPages]);
  const rows = ranked.map((item) => (
    <ListRow
      key={`${item.catalog}_${item.id}`}
      title={<WithReading text={item.name} yomi={item.nameYomi} />}
      subtitle={
        item.songCount !== undefined
          ? t(countKey("search.songCount", item.songCount), {
              count: item.songCount,
            })
          : item.artistName && (
              <WithReading text={item.artistName} yomi={item.artistNameYomi} />
            )
      }
      source={sourceName(item.catalog)}
      to={`${PAGES[item.catalog][by]}${item.id}`}
      state={{ artistNameYomi: item.artistNameYomi }}
    />
  ));

  const active = catalogs.map((catalog) => searches[catalog]);
  const loading = active.some((search) => search.isPending);
  const failed = catalogs.filter((catalog) => searches[catalog].isLoadingError);
  const failedMore = catalogs.filter(
    (catalog) => searches[catalog].isFetchNextPageError,
  );

  return (
    <>
      {failed.map((catalog) => (
        <InlineError
          key={catalog}
          className={styles.error}
          onRetry={() => void searches[catalog].refetch()}
        >
          {t("search.failed", {
            source: sourceName(catalog),
            reason: searches[catalog].error?.message ?? "",
          })}
        </InlineError>
      ))}
      {rows.length > 0 && <List label={t("search.results")}>{rows}</List>}
      {loading && <Loader />}
      {!loading && failed.length === 0 && rows.length === 0 && (
        <EmptyState>{t("search.noResults")}</EmptyState>
      )}
      {failedMore.map((catalog) => (
        <InlineError key={catalog} className={styles.error}>
          {t("search.moreFailed", {
            source: sourceName(catalog),
            reason: searches[catalog].error?.message ?? "",
          })}
        </InlineError>
      ))}
      <MoreButton
        paged={{
          hasNext: active.some((search) => search.hasNextPage),
          isLoadingNext: active.some((search) => search.isFetchingNextPage),
          nextError: null,
          loadNext: () => {
            for (const search of active) {
              if (search.hasNextPage && !search.isFetchingNextPage) {
                void search.fetchNextPage();
              }
            }
          },
        }}
      />
    </>
  );
};

// Its props are three strings, so typing in the search box (before the
// debounced query changes) doesn't render the results again.
export default memo(SearchResults);
