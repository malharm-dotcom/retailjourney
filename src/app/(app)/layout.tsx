import { TopBar } from "@/components/shell/top-bar";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, scope } = await requireSession();
  return (
    <>
      <TopBar user={user} scope={scope} />
      <main className="wrap pb-12">{children}</main>
    </>
  );
}
