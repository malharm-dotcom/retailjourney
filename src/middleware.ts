export { default } from "next-auth/middleware";

export const config = {
  // Everything is behind auth except the login page, auth API and static assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
