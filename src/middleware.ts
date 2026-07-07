export { default } from "next-auth/middleware";

export const config = {
  // Everything is behind auth except the login page, auth API, inbound
  // webhooks (authenticated by their own shared secret) and static assets.
  matcher: ["/((?!api/auth|api/webhooks|login|_next/static|_next/image|favicon.ico).*)"],
};
