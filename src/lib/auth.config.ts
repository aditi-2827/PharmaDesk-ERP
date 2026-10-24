import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";

const OWNER_ONLY_PREFIXES = [
  "/inventory",
  "/purchases",
  "/sales",
  "/expiry",
  "/gst",
  "/reports",
  "/audit",
  "/backup",
  "/users",
  "/settings",
];

function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async authorized({ auth, request }) {
      const isLoginPage = request.nextUrl.pathname === "/login";
      const isLoggedIn = !!auth?.user?.id;

      if (isLoginPage) {
        if (isLoggedIn) {
          return NextResponse.redirect(new URL("/", request.nextUrl));
        }
        return true;
      }

      if (!isLoggedIn) return false;

      if (isOwnerOnlyPath(request.nextUrl.pathname) && auth.user.role !== "owner") {
        return NextResponse.redirect(new URL("/?forbidden=1", request.nextUrl));
      }

      return true;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
