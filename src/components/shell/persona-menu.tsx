"use client";

// The signed-in user's menu. This used to double as a persona switcher that
// could re-authenticate as any other user without a password; that provider is
// gone, so this now only ever shows the real session user.

import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { ROLE_POLICY } from "@/lib/rbac";
import type { User } from "@/lib/types";

function initials(name: string): string {
  return name
    .split(/[\s(]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function UserMenu({
  user,
  isAdmin,
}: {
  user: Pick<User, "id" | "name" | "email" | "role">;
  isAdmin: boolean;
}) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="flex items-center gap-2.5 rounded-[10px] px-1.5 py-1 text-[12.5px] text-ink-soft transition-colors hover:bg-line/60">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-full bg-sage font-display text-xs font-bold text-white">
            {initials(user.name)}
          </span>
          <span className="hidden sm:block">
            <span className="block font-semibold leading-tight text-ink">{user.name.split(" (")[0]}</span>
            <span className="block text-[11px] leading-tight text-mute">{ROLE_POLICY[user.role].label}</span>
          </span>
        </button>
      </DropdownTrigger>
      <DropdownContent align="end" className="max-h-[70vh] overflow-y-auto">
        <DropdownLabel className="px-3 py-1.5">
          <span className="block text-[12.5px] font-semibold text-ink">{user.name.split(" (")[0]}</span>
          <span className="mono block text-[10.5px] text-mute">{user.email}</span>
          <span className="block text-[10.5px] text-mute">{ROLE_POLICY[user.role].label}</span>
        </DropdownLabel>
        <DropdownSeparator />
        {isAdmin ? (
          <>
            <DropdownItem asChild>
              <Link href="/admin">Admin console</Link>
            </DropdownItem>
            <DropdownSeparator />
          </>
        ) : null}
        <DropdownItem onSelect={() => signOut({ callbackUrl: "/login" })}>Sign out</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
