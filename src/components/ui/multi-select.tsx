"use client";

// Checkbox dropdown for GET filter forms. Every option is a real
// `<input type="checkbox" name=…>`, so a plain form submit sends one value per
// ticked box (?courier=A&courier=B) — no hidden-field syncing, and the URL
// stays shareable. Nothing ticked means "all", same as the old single select.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/ui";

export interface MultiOption {
  value: string;
  label?: string;
}

export function MultiSelect({
  name,
  options,
  defaultValue = [],
  allLabel = "All",
  className,
  value,
  onChange,
  searchable = false,
}: {
  name: string;
  options: (string | MultiOption)[];
  defaultValue?: string[];
  allLabel?: string;
  className?: string;
  /** Controlled mode, for a bar that applies each tick itself rather than
   *  submitting a form. Omit both to keep the plain GET-form behaviour. */
  value?: string[];
  onChange?: (picked: string[]) => void;
  /** A type-to-narrow box at the top of the list, for long option lists. */
  searchable?: boolean;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : { label: o.value, ...o }));
  const [own, setOwn] = useState<string[]>(defaultValue.filter((v) => opts.some((o) => o.value === v)));
  const picked = value ?? own;
  const setPicked = (next: string[]) => {
    setOwn(next);
    onChange?.(next);
  };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // Opening a searchable list puts the cursor in its box, so typing a store
  // name is the very next thing that works.
  useEffect(() => {
    if (open && searchable) search.current?.focus();
    if (!open) setQuery("");
  }, [open, searchable]);

  const needle = query.trim().toLowerCase();
  const matches = (o: { label: string }) => !needle || o.label.toLowerCase().includes(needle);
  const shown = opts.filter(matches);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const toggle = (v: string) => setPicked(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
  const summary =
    picked.length === 0 || picked.length === opts.length
      ? allLabel
      : picked.length === 1
        ? (opts.find((o) => o.value === picked[0])?.label ?? picked[0])
        : `${picked.length} selected`;

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-control border border-line-control bg-paper px-3 py-2 text-left text-ui text-ink outline-none transition-colors duration-150 ease-ui focus:border-sage"
      >
        <span className="truncate">{summary}</span>
        <Icon name="alt-arrow-down-bold" size={12} className={cn("shrink-0 text-mute transition-transform", open && "rotate-180")} />
      </button>
      {/* Always rendered — a hidden checkbox still submits — so closing the
          panel never drops a selection from the form. */}
      <div
        role="listbox"
        aria-multiselectable
        className={cn(
          "absolute left-0 z-30 mt-1 max-h-72 min-w-full overflow-auto rounded-control bg-card p-1.5 shadow-pop",
          !open && "hidden",
        )}
      >
        {searchable ? (
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search…"
            aria-label="Search options"
            className="mb-1.5 w-full rounded-control border border-line-control bg-paper px-2.5 py-1.5 text-ui text-ink outline-none focus:border-sage"
          />
        ) : null}
        <div className="flex justify-between gap-3 px-2 pb-1.5 pt-0.5 text-meta font-semibold">
          {/* With a search typed, "Select all" adds what the search shows —
              never options the operator cannot see. */}
          <button
            type="button"
            className="text-sage hover:underline"
            onClick={() => setPicked([...new Set([...picked, ...shown.map((o) => o.value)])])}
          >
            Select all
          </button>
          <button type="button" className="text-mute hover:text-ink" onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
        {opts.length === 0 ? <p className="px-2 py-1.5 text-dense text-mute">Nothing to choose from</p> : null}
        {opts.length > 0 && shown.length === 0 ? <p className="px-2 py-1.5 text-dense text-mute">No match</p> : null}
        {/* Non-matching options are hidden, not unrendered: a hidden checkbox
            still submits, so searching never drops a tick from the form. */}
        {opts.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-control px-2 py-1.5 text-ui text-ink-soft hover:bg-sage-soft hover:text-sage",
              !matches(o) && "hidden",
            )}
          >
            <input
              type="checkbox"
              name={name}
              value={o.value}
              checked={picked.includes(o.value)}
              onChange={() => toggle(o.value)}
              className="h-4 w-4 accent-ink"
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}
