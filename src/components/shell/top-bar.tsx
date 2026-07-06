import Link from "next/link";
import { FacilitySwitcher } from "./facility-switcher";
import { Nav } from "./nav";
import { PersonaMenu } from "./persona-menu";
import { devPersonaEnabled } from "@/lib/auth";
import { entitledFacilities, policyOf } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import type { FacilityScope, User } from "@/lib/types";

export async function TopBar({ user, scope }: { user: User; scope: FacilityScope }) {
  const policy = policyOf(user.role);
  const personas = devPersonaEnabled()
    ? (await repo.listUsers()).filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role }))
    : [];

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ground/80 backdrop-blur-md backdrop-saturate-150">
      <div className="wrap flex h-[66px] items-center gap-4 lg:gap-6">
        <Link href="/" className="flex items-center font-display text-[22px] font-extrabold tracking-tight">
          RetailJourney<span className="ml-px text-sage">#</span>
        </Link>
        <Nav />
        <div className="flex-1" />
        {policy.canSwitchFacility ? (
          <FacilitySwitcher
            current={scope}
            options={entitledFacilities(user)}
            allView={policy.allView && user.allView}
          />
        ) : null}
        <PersonaMenu
          user={{ id: user.id, name: user.name, role: user.role }}
          personas={personas}
          isAdmin={policy.isAdmin}
        />
      </div>
    </header>
  );
}
