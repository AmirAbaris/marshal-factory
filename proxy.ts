import { NextResponse, type NextRequest } from "next/server";
import { isOwner } from "@/lib/auth/owner";
import { auth } from "@/lib/auth/server";

const LOGIN = "/auth/sign-in";
// The SDK middleware re-mints the cached session cookie that getSession alone cannot set from a proxy.
const refreshSession = auth.middleware({ loginUrl: LOGIN });

export async function proxy(request: NextRequest) {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (user && isOwner(user.email)) return refreshSession(request);
  const api = request.nextUrl.pathname.startsWith("/api/");
  if (!user) {
    return api
      ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      : NextResponse.redirect(new URL(LOGIN, request.url));
  }
  return api
    ? NextResponse.json({ error: "Forbidden" }, { status: 403 })
    : NextResponse.rewrite(new URL("/auth/forbidden", request.url), { status: 403 });
}

export const config = {
  matcher: ["/((?!auth/|api/auth/|_next/static|_next/image|favicon.ico).*)"],
};
