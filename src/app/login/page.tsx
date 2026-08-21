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
          Any @snitch.com Google account can sign in. New accounts start read-only — ask an admin to
          grant the access your role needs.
        </p>
      </div>
    </div>
  );
}
