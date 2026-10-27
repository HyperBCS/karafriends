// Offset paging maths, kept apart from the HTTP clients so unit tests can
// load it under plain Node.

// DAM's search APIs answer in fixed pages of 30, numbered from 1.
export const DAM_PAGE_SIZE = 30;

// Which DAM pages cover results [offset, offset + limit), and where those
// results sit in the joined pages' list.
export function damPageWindow(
  offset: number,
  limit: number,
): { firstPage: number; pageCount: number; start: number; end: number } {
  const firstIndex = Math.floor(offset / DAM_PAGE_SIZE);
  // At least one page: its totals are needed even for an empty slice.
  const lastIndex = Math.max(
    firstIndex,
    Math.floor((offset + limit - 1) / DAM_PAGE_SIZE),
  );
  const start = offset - firstIndex * DAM_PAGE_SIZE;
  return {
    firstPage: firstIndex + 1,
    pageCount: lastIndex - firstIndex + 1,
    start,
    end: start + Math.max(limit, 0),
  };
}

// The offset of the page after [offset, offset + limit) of `total` results,
// or null if that was the last.
export function nextOffset(
  offset: number,
  limit: number,
  total: number,
): number | null {
  return offset + limit < total ? offset + limit : null;
}
