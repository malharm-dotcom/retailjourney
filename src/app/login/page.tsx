import { devPersonaEnabled, googleConfigured } from "@/lib/auth";
import { USERS } from "@/lib/seed/users";
import { LoginPanel } from "./login-panel";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  const personas = devPersonaEnabled()
    ? USERS.filter((u) => u.active).map(({ id, name, role, email }) => ({ id, name, role, email }))
    : [];
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-8 text-center">
          <div className="font-display text-[40px] font-extrabold tracking-tight">
            Relay<span className="text-sage">#</span>
          </div>
          <p className="mt-1 text-sm text-mute">
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
