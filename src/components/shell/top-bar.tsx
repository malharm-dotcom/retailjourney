import { FacilitySwitcher } from "./facility-switcher";
import { UserMenu } from "./persona-menu";
import { entitledFacilities, policyOf } from "@/lib/rbac";
import type { FacilityScope, User } from "@/lib/types";

/** The global controls that sit on the right of the top bar (facility switcher +
 *  user menu). Rendered server-side; the AppShell places them in the header.
 *  `user` is the authenticated session user — there is no persona switching. */
export async function TopBarControls({ user, scope }: { user: User; scope: FacilityScope }) {
  const policy = policyOf(user.role);

  return (
    <>
      {policy.canSwitchFacility ? (
        <FacilitySwitcher
          current={scope}
          options={entitledFacilities(user)}
          allView={policy.allView && user.allView}
        />
      ) : null}
      <UserMenu user={{ id: user.id, name: user.name, email: user.email, role: user.role }} isAdmin={policy.isAdmin} />
    </>
  );
}
