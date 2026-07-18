import { AppShell } from "@/components/shell/app-shell";
import { SyncStatus } from "@/components/shell/sync-status";
import { TopBarControls } from "@/components/shell/top-bar";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, scope } = await requireSession();
  return (
    <AppShell controls={<TopBarControls user={user} scope={scope} />} syncStrip={<SyncStatus />}>
      {children}
    </AppShell>
  );
}
