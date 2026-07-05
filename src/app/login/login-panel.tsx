"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { ROLE_POLICY } from "@/lib/rbac";
import { cn } from "@/lib/ui";
import type { Role } from "@/lib/types";

interface Persona {
  id: string;
  name: string;
  role: Role;
  email: string;
}

export function LoginPanel({ google, personas }: { google: boolean; personas: Persona[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const enter = async (p: Persona) => {
    setBusy(p.id);
    const res = await signIn("persona", { userId: p.id, redirect: false });
    setBusy(null);
    if (res?.error) {
      toast.error("Sign-in failed — persona not active");
      return;
    }
    router.push("/");
    router.refresh();
  };

  return (
    <div className="rounded-2xl bg-card p-6 shadow-card">
      {google ? (
        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="mb-5 flex w-full items-center justify-center gap-2 rounded-[10px] bg-ink py-3 text-[13.5px] font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Continue with Google — @snitch.com
        </button>
      ) : null}

      {personas.length ? (
        <>
          <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {google ? "Or enter as a demo persona" : "Enter as a demo persona"}
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {personas.map((p) => (
              <button
                key={p.id}
                onClick={() => enter(p)}
                disabled={busy !== null}
                className={cn(
                  "flex items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5 text-left transition-all hover:border-sage hover:bg-sage-soft",
                  busy === p.id && "opacity-60",
                )}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sage font-display text-[11px] font-bold text-white">
                  {p.name
                    .split(/[\s(]+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]!.toUpperCase())
                    .join("")}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink">
                    {p.name.split(" (")[0]}
                  </span>
                  <span className="block text-[11px] text-mute">{ROLE_POLICY[p.role].label}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : !google ? (
        <p className="text-center text-sm text-mute">
          Sign-in is not configured yet. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
        </p>
      ) : null}
    </div>
  );
}
