import { useInfiniteQuery } from "@tanstack/react-query";
import React, { memo, useMemo } from "react";

import type { Page } from "../../common/api";
import { call } from "../../common/apiClient";
import { countKey, t } from "../i18n";
import { kanaQuery, rank } from "../rank";
import songLink, { artistLink, sourceName } from "../songLink";
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
  // Which catalogs are on (useCatalog): only those are searched.
  damOn: boolean;
  joysoundOn: boolean;
}

// DAM's and Joysound's answers to a search in one list, best match first
// (see rank), ranked again as each page comes in. Each row says which
// catalog it's from. A query typed in romaji is searched for in kana too
// (kanaQuery), and those results join the query's.
const SearchResults = ({ query, by, source, damOn, joysoundOn }: Props) => {
  const on = { dam: damOn, joysound: joysoundOn };
  const catalogs = (["dam", "joysound"] as const).filter(
    (catalog) => on[catalog] && (source === "all" || source === catalog),
  );
  const kana = kanaQuery(query);
  const searchesOf = {
    dam: [
      useCatalogSearch("dam", by, query, catalogs.includes("dam")),
      useCatalogSearch(
        "dam",
        by,
        kana ?? "",
        kana !== null && catalogs.includes("dam"),
      ),
    ],
    joysound: [
      useCatalogSearch("joysound", by, query, catalogs.includes("joysound")),
      useCatalogSearch(
        "joysound",
        by,
        kana ?? "",
        kana !== null && catalogs.includes("joysound"),
      ),
    ],
  };
  // A catalog's searches that run: the query's, then the kana's if any.
  const searches = (catalog: Catalog) =>
    kana === null ? searchesOf[catalog].slice(0, 1) : searchesOf[catalog];
  // Each catalog's loaded pages, the query's first, without the repeats a
  // shifting catalog can put on a later page or the kana's search finds
  // too. Ranked again only when a page comes in (or the query changes).
  const damPages = searchesOf.dam[0].data?.pages;
  const damKanaPages = searchesOf.dam[1].data?.pages;
  const joysoundPages = searchesOf.joysound[0].data?.pages;
  const joysoundKanaPages = searchesOf.joysound[1].data?.pages;
  const ranked = useMemo(() => {
    const pages = {
      dam: [damPages, kana === null ? undefined : damKanaPages],
      joysound: [joysoundPages, kana === null ? undefined : joysoundKanaPages],
    };
    const found = catalogs.map((catalog) => {
      const seen = new Set<string>();
      return pages[catalog]
        .flatMap((list) => list ?? [])
        .flatMap((page) => page.items)
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .map((item) => ({ ...item, catalog }));
    });
    return rank(query, found);
  }, [
    query,
    kana,
    source,
    damOn,
    joysoundOn,
    damPages,
    damKanaPages,
    joysoundPages,
    joysoundKanaPages,
  ]);
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
      to={
        by === "title"
          ? songLink({ kind: item.catalog, songId: item.id })
          : artistLink(item.catalog, item.id)
      }
      state={{ artistNameYomi: item.artistNameYomi }}
    />
  ));

  const active = catalogs.flatMap(searches);
  const loading = active.some((search) => search.isPending);
  // A catalog's failed searches: one line for the catalog, whichever failed.
  const failedOf = (catalog: Catalog) =>
    searches(catalog).filter((search) => search.isLoadingError);
  const failed = catalogs.filter((catalog) => failedOf(catalog).length > 0);
  const failedMore = catalogs.filter((catalog) =>
    searches(catalog).some((search) => search.isFetchNextPageError),
  );
  const reason = (catalog: Catalog) =>
    searches(catalog).find((search) => search.error)?.error?.message ?? "";

  return (
    <>
      {failed.map((catalog) => (
        <InlineError
          key={catalog}
          className={styles.error}
          onRetry={() => {
            for (const search of failedOf(catalog)) void search.refetch();
          }}
        >
          {t("search.failed", {
            source: sourceName(catalog),
            reason: reason(catalog),
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
            reason: reason(catalog),
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

// Its props are strings and booleans, so typing in the search box (before the
// debounced query changes) doesn't render the results again.
export default memo(SearchResults);
