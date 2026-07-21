import { Suspense } from "react";
import { googleConfigured } from "@/lib/auth";
import { LoginPanel } from "./login-panel";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snitch-wordmark.png" alt="Snitch" className="h-9 w-auto" />
          <p className="mt-3 text-sm text-mute">
            The baton passing cleanly between Merchandising, Warehouse, Logistics and Store.
          </p>
        </div>
        <Suspense>
          <LoginPanel google={googleConfigured()} />
        </Suspense>
        <p className="mt-6 text-center text-xs text-mute">
          Accounts are created by an admin — there is no self-signup. Ask an admin if you need access.
        </p>
      </div>
    </div>
  );
}
