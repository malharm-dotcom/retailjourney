// Client-side paging over a list the table has already filtered and sorted.
// Only the page is rendered — counts, select-all and CSV exports keep reading
// the full list, so nothing but the DOM size changes.

import { useEffect, useState } from "react";

export const TABLE_PAGE_SIZE = 100;

/** Back to page 1 whenever `resetKey` (the filters) changes. A data refresh
 *  that only shrinks the list clamps to the last page instead of jumping. */
export function usePaged<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const current = Math.min(page, Math.max(1, Math.ceil(items.length / TABLE_PAGE_SIZE)));
  const offset = (current - 1) * TABLE_PAGE_SIZE;
  return { rows: items.slice(offset, offset + TABLE_PAGE_SIZE), page: current, offset, setPage };
}
