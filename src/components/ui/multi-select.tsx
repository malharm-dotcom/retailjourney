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
}: {
  name: string;
  options: (string | MultiOption)[];
  defaultValue?: string[];
  allLabel?: string;
  className?: string;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : { label: o.value, ...o }));
  const [picked, setPicked] = useState<string[]>(defaultValue.filter((v) => opts.some((o) => o.value === v)));
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const summary =
    picked.length === 0 || picked.length === opts.length
      ? allLabel
      : picked.length === 1
        ? opts.find((o) => o.value === picked[0])!.label
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
        <div className="flex justify-between gap-3 px-2 pb-1.5 pt-0.5 text-meta font-semibold">
          <button type="button" className="text-sage hover:underline" onClick={() => setPicked(opts.map((o) => o.value))}>
            Select all
          </button>
          <button type="button" className="text-mute hover:text-ink" onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
        {opts.length === 0 ? <p className="px-2 py-1.5 text-dense text-mute">Nothing to choose from</p> : null}
        {opts.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-control px-2 py-1.5 text-ui text-ink-soft hover:bg-sage-soft hover:text-sage"
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
