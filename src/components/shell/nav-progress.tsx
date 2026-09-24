"use client";

// One loading indicator for every in-app navigation. Next shows loading.tsx on
// a route change, but a navigation that stays on the same route — a filter, a
// page of results, a sort — has nothing to show while the server re-renders,
// so the screen looked frozen for the second or two it took.
//
// It starts on the cause (an internal link click, a GET form submit, or an
// explicit NAV_START from code that calls router.push) and ends on the effect
// (the pathname or query actually changing). Shown only after a short delay, so
// a navigation that lands at once never flashes it.

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/ui";

export const NAV_START = "rj:navigate";

/** Call before a programmatic router.push so the indicator knows. */
export function signalNavigation(): void {
  window.dispatchEvent(new Event(NAV_START));
}

const SHOW_AFTER_MS = 150;
/** A navigation that never lands (offline, an error page) must not spin forever. */
const GIVE_UP_MS = 20_000;

export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [started, setStarted] = useState(0);
  const [visible, setVisible] = useState(false);

  // Landed.
  useEffect(() => setStarted(0), [pathname, search]);

  useEffect(() => {
    if (!started) return setVisible(false);
    const show = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    const stop = setTimeout(() => setStarted(0), GIVE_UP_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(stop);
    };
  }, [started]);

  useEffect(() => {
    const begin = () => setStarted(Date.now());
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      begin();
    };
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement;
      if (!e.defaultPrevented && (f.getAttribute("method") ?? "get").toLowerCase() === "get") begin();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    window.addEventListener(NAV_START, begin);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener(NAV_START, begin);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2",
        "flex items-center gap-2 rounded-full bg-card/85 px-3.5 py-1.5 text-cap font-semibold text-ink-soft shadow-lift backdrop-blur-md",
        "transition-opacity duration-200 ease-ui",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {visible ? (
        <>
          <Spinner size={13} />
          Loading
        </>
      ) : null}
    </div>
  );
}
