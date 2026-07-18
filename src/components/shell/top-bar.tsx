import { FacilitySwitcher } from "./facility-switcher";
import { PersonaMenu } from "./persona-menu";
import { devPersonaEnabled } from "@/lib/auth";
import { entitledFacilities, policyOf } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import type { FacilityScope, User } from "@/lib/types";

/** The global controls that sit on the right of the top bar (facility switcher +
 *  persona menu). Rendered server-side; the AppShell places them in the header. */
export async function TopBarControls({ user, scope }: { user: User; scope: FacilityScope }) {
  const policy = policyOf(user.role);
  const personas = devPersonaEnabled()
    ? (await repo.listUsers()).filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role }))
    : [];

  return (
    <>
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
    </>
  );
}
