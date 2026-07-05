"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, signOut } from "next-auth/react";
import { toast } from "sonner";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { ROLE_POLICY } from "@/lib/rbac";
import type { Role, User } from "@/lib/types";

function initials(name: string): string {
  return name
    .split(/[\s(]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function PersonaMenu({
  user,
  personas,
  isAdmin,
}: {
  user: Pick<User, "id" | "name" | "role">;
  personas: Pick<User, "id" | "name" | "role">[]; // empty = persona switching disabled
  isAdmin: boolean;
}) {
  const router = useRouter();

  const switchTo = async (p: Pick<User, "id" | "name">) => {
    const res = await signIn("persona", { userId: p.id, redirect: false });
    if (res?.error) {
      toast.error("Could not switch persona");
      return;
    }
    toast.success(`Now viewing as ${p.name}`);
    router.refresh();
  };

  const byRole = personas.reduce<Map<Role, typeof personas>>((m, p) => {
    const arr = m.get(p.role) ?? [];
    arr.push(p);
    m.set(p.role, arr);
    return m;
  }, new Map());

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
        {isAdmin ? (
          <>
            <DropdownItem asChild>
              <Link href="/admin">Admin console</Link>
            </DropdownItem>
            <DropdownSeparator />
          </>
        ) : null}
        {personas.length ? (
          <>
            <DropdownLabel className="px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
              View as persona
            </DropdownLabel>
            {[...byRole.entries()].map(([role, list]) => (
              <div key={role}>
                {list.map((p) => (
                  <DropdownItem key={p.id} onSelect={() => switchTo(p)}>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-line text-[10px] font-bold text-ink-soft">
                      {initials(p.name)}
                    </span>
                    <span className="flex-1">{p.name.split(" (")[0]}</span>
                    <span className="text-[10.5px] text-mute">{ROLE_POLICY[role].label}</span>
                  </DropdownItem>
                ))}
              </div>
            ))}
            <DropdownSeparator />
          </>
        ) : null}
        <DropdownItem onSelect={() => signOut({ callbackUrl: "/login" })}>Sign out</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
