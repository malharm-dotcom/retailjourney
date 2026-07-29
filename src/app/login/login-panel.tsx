"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { cn } from "@/lib/ui";

export function LoginPanel({ google }: { google: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never bounce to an absolute URL an attacker put in the query string.
  const raw = params.get("callbackUrl") ?? "/";
  const callbackUrl = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error || !res?.ok) {
      // One message for every failure mode: a wrong password and an unknown
      // or deactivated account must not be distinguishable.
      setError("Incorrect email or password, or the account is not active.");
      setPassword("");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  };

  return (
    <div className="rounded-card bg-card p-6 shadow-card">
      {google ? (
        <>
          {/* Secondary. The email + password form below it is the provisioned path
              (there is no self-signup — accounts come from the seed script), so the
              ink primary belongs to that submit, not to this. */}
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl })}
            className="flex w-full items-center justify-center gap-2 rounded-control border border-line-control bg-paper py-3 text-ui font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:bg-sage-soft hover:text-sage"
          >
            Continue with Google — @snitch.com
          </button>
          <div className="my-5 flex items-center gap-3 text-cap uppercase tracking-[0.06em] text-mute">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      ) : null}

      <form onSubmit={submit} className="grid gap-3.5">
        <label className="grid gap-1.5">
          <span className="text-cap font-semibold uppercase tracking-[0.06em] text-mute">Email</span>
          <input
            type="email"
            required
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-control border border-line bg-paper px-3.5 py-2.5 text-ui text-ink outline-none transition-colors duration-150 ease-ui focus:border-sage"
            placeholder="you@snitch.com"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-cap font-semibold uppercase tracking-[0.06em] text-mute">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-control border border-line bg-paper px-3.5 py-2.5 text-ui text-ink outline-none transition-colors duration-150 ease-ui focus:border-sage"
          />
        </label>

        {error ? (
          <p role="alert" className="rounded-control bg-breach-bg px-3.5 py-2.5 text-dense font-semibold text-breach">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className={cn(
            // Was `bg-sage`, which put a second primary in a 420px panel beside the
            // ink "Continue with Google" and contradicted `variant="primary"`
            // (bg-ink) everywhere else in the product. One primary per decision.
            "mt-1 rounded-control bg-ink py-3 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85",
            busy && "opacity-60",
          )}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
