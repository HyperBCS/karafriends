import { useInfiniteQuery } from "@tanstack/react-query";
import React from "react";

import type { Page } from "../../common/api";
import { call } from "../../common/apiClient";
import { t } from "../i18n";
import Loader from "./Loader";
import MoreButton from "./MoreButton";
import * as styles from "./SearchResults.module.scss";
import { EmptyState, InlineError, List, ListRow } from "./ui";

export type SearchBy = "title" | "artist";
export type SearchSource = "all" | "dam" | "joysound";
type Catalog = "dam" | "joysound";

const METHODS = {
  dam: { title: "damSearchSongs", artist: "damSearchArtists" },
  joysound: { title: "joysoundSearchSongs", artist: "joysoundSearchArtists" },
} as const;

// What the four searches answer with, as far as a row needs: a song
// (with its artist) or an artist (with DAM's song count).
interface Found {
  id: string;
  name: string;
  artistName?: string;
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

// DAM's and Joysound's answers to a search, a page from each in turn, in the
// order each catalog returned them. Each row says which catalog it's from.
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

  const rows: React.ReactNode[] = [];
  const seen = new Set<string>();
  const pageCount = Math.max(
    ...catalogs.map((catalog) => searches[catalog].data?.pages.length ?? 0),
  );
  for (let i = 0; i < pageCount; i++) {
    for (const catalog of catalogs) {
      for (const item of searches[catalog].data?.pages[i]?.items ?? []) {
        const key = `${catalog}_${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(
          <ListRow
            key={key}
            title={item.name}
            subtitle={
              item.songCount !== undefined
                ? t("search.songCount", { count: item.songCount })
                : item.artistName
            }
            source={sourceName(catalog)}
            to={`${PAGES[catalog][by]}${item.id}`}
          />,
        );
      }
    }
  }

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
      {rows.length > 0 && (
        <List label={t("search.results")} className={styles.list}>
          {rows}
        </List>
      )}
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

export default SearchResults;
