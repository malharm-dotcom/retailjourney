"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { Sidebar } from "./sidebar";

/** App chrome: left sidebar (desktop) / drawer (mobile) + a slim top bar that
 *  carries the global controls and the sync-freshness strip. Server-rendered
 *  pieces (facility switcher, persona menu, sync status) come in as nodes. */
export function AppShell({
  controls,
  syncStrip,
  children,
}: {
  controls: React.ReactNode;
  syncStrip: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-dvh lg:flex">
      <Sidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-ground/80 backdrop-blur-md backdrop-saturate-150">
          <div className="flex h-[60px] items-center gap-3 px-5 sm:px-7">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="grid h-9 w-9 place-items-center rounded-[10px] text-ink-soft hover:bg-line/60 lg:hidden"
            >
              <Icon name="hamburger-menu-linear" size={20} />
            </button>
            <Link href="/" className="flex items-center lg:hidden" aria-label="RetailJourney — Snitch">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/snitch-wordmark.png" alt="Snitch" className="h-[20px] w-auto" />
            </Link>
            <div className="flex-1" />
            <div className="flex items-center gap-3 lg:gap-4">{controls}</div>
          </div>
          <div className="flex justify-end border-t border-line/60 px-5 py-[3px] sm:px-7">{syncStrip}</div>
        </header>

        <main className="mx-auto w-full max-w-[1360px] px-5 pb-12 sm:px-7">{children}</main>
      </div>
    </div>
  );
}
