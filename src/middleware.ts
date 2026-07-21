// Route guard. This is the coarse net: it redirects unauthenticated traffic to
// /login before a page renders. It is NOT the authorisation boundary — every
// server action and route handler re-checks the session and the role itself
// (see lib/session.ts + lib/rbac.ts), because middleware runs on the edge and
// can never be the only thing standing between a user and a mutation.

import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/login" },
});

export const config = {
  // Everything is behind auth except the login page, auth API, inbound
  // webhooks (authenticated by their own shared secret) and static assets.
  matcher: ["/((?!api/auth|api/webhooks|login|_next/static|_next/image|favicon.ico).*)"],
};
