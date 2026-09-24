import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { NavProgress } from "@/components/shell/nav-progress";
import { SyncStatus } from "@/components/shell/sync-status";
import { TopBarControls } from "@/components/shell/top-bar";
import { canUseTracker, policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, scope } = await requireSession();
  return (
    <AppShell
      controls={<TopBarControls user={user} scope={scope} />}
      syncStrip={<SyncStatus />}
      isAdmin={policyOf(user.role).isAdmin}
      canTracker={canUseTracker(user.role)}
    >
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      {children}
    </AppShell>
  );
}
