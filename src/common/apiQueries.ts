// The lookups and commands of the JSON RPC API (src/common/api.ts) as
// TanStack Query hooks over call(), for the phone remote and the display.
// Live state doesn't come through here: see LiveStateProvider in
// apiClient.ts.
//
// Lookups suspend (useSuspenseQuery), so the remote's withLoader shows its
// spinner while they load and its error message if they fail.
import {
  QueryClient,
  useMutation,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { useMemo } from "react";

import type { ApiInput, ApiMethod, ApiOutput, Page } from "./api";
import { call } from "./apiClient";

// How long a lookup's answer is reused without asking the server again, so
// going back to a page shows it at once, as Relay's store did.
export const LOOKUP_STALE_MS = 10 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: LOOKUP_STALE_MS,
        // Kept as long as it's fresh, for going back to it.
        gcTime: LOOKUP_STALE_MS,
        // Like Relay: no retries, so an error shows at once (with a "Try
        // again" button), and no refetching behind the person's back.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  });
}

// A lookup's answer. Suspends until it arrives, and throws its error to the
// nearest error boundary.
export function useApiQuery<M extends ApiMethod>(
  method: M,
  input: ApiInput<M>,
  options: { staleTime?: number } = {},
): ApiOutput<M> {
  return useSuspenseQuery({
    queryKey: [method, input],
    queryFn: () => call(method, input),
    ...options,
  }).data;
}

// The methods that take an offset and answer one page at a time.
export type PagedMethod = {
  [M in ApiMethod]: "offset" extends keyof ApiInput<M> ? M : never;
}[ApiMethod];

export interface Paged<M extends ApiMethod, T> {
  // The first page's whole answer (damArtist has the artist's name in it).
  first: ApiOutput<M>;
  // Every page's items so far, without repeats.
  items: T[];
  hasNext: boolean;
  isLoadingNext: boolean;
  // Why the last "More" failed, if it did.
  nextError: Error | null;
  loadNext: () => void;
}

// A list with a "More" button: the first page suspends like useApiQuery, and
// loadNext() adds the next one. pageOf finds the page in an answer, and keyOf
// tells items apart, so one that moved to the next page while the person
// read this one shows only once.
export function usePagedApiQuery<M extends PagedMethod, T>(
  method: M,
  input: Omit<ApiInput<M>, "offset" | "limit">,
  pageOf: (output: ApiOutput<M>) => Page<T>,
  keyOf: (item: T) => string,
  options: { staleTime?: number } = {},
): Paged<M, T> {
  const query = useSuspenseInfiniteQuery({
    // "paged" keeps these apart from useApiQuery's answers.
    queryKey: [method, input, "paged"],
    queryFn: ({ pageParam }) =>
      call(method, { ...input, offset: pageParam } as ApiInput<M>),
    initialPageParam: 0,
    getNextPageParam: (last: ApiOutput<M>) =>
      pageOf(last).nextOffset ?? undefined,
    ...options,
  });
  const { pages } = query.data;

  const items = useMemo(() => {
    const seen = new Set<string>();
    return pages.flatMap((page) =>
      pageOf(page).items.filter((item) => {
        const key = keyOf(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    // pageOf and keyOf are expected not to change what they do.
  }, [pages]);

  return {
    first: pages[0],
    items,
    hasNext: query.hasNextPage,
    isLoadingNext: query.isFetchingNextPage,
    nextError: query.isFetchNextPageError ? query.error : null,
    loadNext: () => {
      if (!query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}

// A command. mutate(input) runs it; onSuccess and onError work as in
// useMutation.
export function useApiMutation<M extends ApiMethod>(
  method: M,
  options: Omit<
    UseMutationOptions<ApiOutput<M>, Error, ApiInput<M>>,
    "mutationFn"
  > = {},
) {
  return useMutation<ApiOutput<M>, Error, ApiInput<M>>({
    mutationFn: (input) => call(method, input),
    ...options,
  });
}
