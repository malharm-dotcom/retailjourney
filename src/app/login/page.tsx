import { devPersonaEnabled, googleConfigured } from "@/lib/auth";
import { repo } from "@/lib/repo";
import { LoginPanel } from "./login-panel";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const personas = devPersonaEnabled()
    ? (await repo.listUsers()).filter((u) => u.active).map(({ id, name, role, email }) => ({ id, name, role, email }))
    : [];
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snitch-wordmark.png" alt="Snitch" className="h-9 w-auto" />
          <p className="mt-3 text-sm text-mute">
            The baton passing cleanly between Merchandising, Warehouse, Logistics and Store.
          </p>
        </div>
        <LoginPanel google={googleConfigured()} personas={personas} />
        <p className="mt-6 text-center text-xs text-mute">
          Access is limited to activated @snitch.com accounts. Ask an admin if you need in.
        </p>
      </div>
    </div>
  );
}
