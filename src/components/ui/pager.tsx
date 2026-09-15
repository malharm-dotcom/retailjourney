// Page controls for long lists. Links when the page lives in the URL (the
// server-rendered /orders list), buttons when it lives in client state (the
// board tables) — the same look either way. No hooks here, so a server page
// can render it too.

import Link from "next/link";
import { cn } from "@/lib/ui";

const BTN =
  "min-h-[34px] rounded-control border border-line-control px-3 py-1.5 text-ui font-semibold transition-colors duration-150 ease-ui";

export function Pager({
  page,
  pageSize,
  total,
  hrefFor,
  onPage,
}: {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  hrefFor?: (page: number) => string;
  onPage?: (page: number) => void;
}) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const step = (p: number, label: string) => {
    const enabled = p >= 1 && p <= pages;
    const cls = cn(BTN, enabled ? "text-ink hover:bg-paper" : "pointer-events-none text-mute opacity-50");
    return hrefFor ? (
      <Link href={hrefFor(p)} aria-disabled={!enabled} tabIndex={enabled ? undefined : -1} className={cls}>
        {label}
      </Link>
    ) : (
      <button type="button" disabled={!enabled} onClick={() => onPage?.(p)} className={cls}>
        {label}
      </button>
    );
  };

  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 px-1 pt-4 text-dense text-mute">
      <p>
        Rows <b className="font-semibold text-ink-soft">{from}–{to}</b> of{" "}
        <b className="font-semibold text-ink-soft">{total}</b> · page {page} of {pages}
      </p>
      <div className="flex gap-2">
        {step(page - 1, "‹ Previous")}
        {step(page + 1, "Next ›")}
      </div>
    </nav>
  );
}
