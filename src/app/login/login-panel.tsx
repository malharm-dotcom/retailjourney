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
  const [formError, setFormError] = useState<string | null>(null);

  // A refused Google sign-in comes back as ?error= on this page, and nothing
  // used to read it — the whole panel just re-rendered blank, so someone
  // bounced for using a personal address saw no reason why. The provider
  // rejects for exactly two causes now (wrong domain, deactivated account) and
  // cannot tell the browser which, so say both.
  const ssoError =
    params.get("error") && !formError
      ? "Google sign-in was refused. Use your @snitch.com account — personal addresses cannot sign in, and a deactivated account needs an admin to restore it."
      : null;
  const error = formError ?? ssoError;

  // Never bounce to an absolute URL an attacker put in the query string.
  const raw = params.get("callbackUrl") ?? "/";
  const callbackUrl = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error || !res?.ok) {
      // One message for every failure mode: a wrong password and an unknown
      // or deactivated account must not be distinguishable.
      setFormError("Incorrect email or password, or the account is not active.");
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
          {/* The ink primary. This inverted when SSO started self-provisioning:
              Google is now the path every @snitch.com employee takes and needs
              no account set up first, while the password form below is the
              leftover for admin-created accounts. One primary per decision, so
              that submit drops to the outline treatment this used to carry. */}
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl })}
            className="flex w-full items-center justify-center gap-2 rounded-control bg-ink py-3 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
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
            // Outline, not ink: the Google button above is the primary now that
            // it self-provisions. Only takes the ink when Google is unconfigured
            // and this is the only way in — a lone button is the primary.
            "mt-1 rounded-control py-3 text-ui font-semibold transition-colors duration-150 ease-ui",
            google
              ? "border border-line-control bg-paper text-ink-soft hover:border-sage hover:bg-sage-soft hover:text-sage"
              : "bg-ink text-paper hover:bg-ink/85",
            busy && "opacity-60",
          )}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
