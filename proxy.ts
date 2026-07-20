import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getSessionSecret,
  verifySessionToken,
} from "./app/lib/auth";
import { getSessionEpoch } from "./app/lib/session-epoch";
import { getUserByEmail, getAdminEmail } from "./app/lib/user-store";

// `/api/img` is the image proxy used by the `image_search` tool. Artifact
// iframes are rendered with `sandbox="allow-scripts"` + `srcDoc`, which gives
// them an opaque/null origin. Browsers treat `<img>` loads from a null-origin
// frame as cross-site, so our `SameSite=Lax` session cookie is never attached
// — every proxied image would 401 here and render as a broken-image glyph.
// The route enforces its own SSRF protections (HTTPS only, private addresses
// blocked, image-only content types, size + time caps) and is also needed by
// unauthenticated share-link recipients, so it's safe to expose publicly.
//
// `/signup`, `/api/signup`, `/api/invites/preview` are reachable before a
// session exists so invited users can create accounts.
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/login",
  "/api/img",
  "/marketing",
  "/signup",
  "/api/signup",
  "/api/invites/preview",
  // Usernameless passkey sign-in happens before any session exists, so its two
  // endpoints must be reachable unauthenticated. They enforce their own
  // security (single-use challenge bound to an HttpOnly cookie + WebAuthn
  // signature verification), and only ever mint a session on a valid assertion.
  "/api/passkey/login/options",
  "/api/passkey/login/verify",
  // Deployed-commit stamp written by scripts/write-version.mjs at build time.
  // Public so "which commit is production actually running?" is answerable
  // without a session (it leaks nothing but a SHA already visible on GitHub).
  "/v.txt",
]);
// Prefixes that bypass the session check. Note the trailing slashes — the
// owner-facing `POST /api/share` deliberately does NOT match `/api/share/`
// and so still requires a valid session.
//
// `/api/chat/continue/` and `/api/cron/` are server-to-server entry points:
// the chat worker hands off to the next worker via a fetch from one Vercel
// function to another, and Vercel Cron pings the schedule sweep every 30
// minutes — neither carries the browser session cookie, so without this
// bypass middleware 401s before the route's own auth ever runs. Both routes
// enforce their own auth in-handler (HMAC over `${streamId}|${seq}` with a
// server-only secret for /chat/continue; `Authorization: Bearer ${CRON_SECRET}`
// for /cron), so the session check here would just be redundant blocking.
const PUBLIC_PREFIXES = [
  "/share/",
  "/api/share/",
  "/api/chat/continue/",
  "/api/cron/",
];

const ADMIN_PAGE_PREFIX = "/admin/";
const ADMIN_API_PREFIX = "/api/admin/";

const USER_EMAIL_HEADER = "x-user-email";

function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith(ADMIN_PAGE_PREFIX) ||
    pathname.startsWith(ADMIN_API_PREFIX)
  );
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Drop any caller-supplied identity header before we go anywhere — this
  // is the only place that's allowed to set it. Without this, a public
  // route could read a spoofed `x-user-email` and serve another user's
  // data. The cleaned headers are what we forward on every code path,
  // including the early-return public-path branch.
  const cleanHeaders = new Headers(req.headers);
  cleanHeaders.delete(USER_EMAIL_HEADER);

  if (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next({ request: { headers: cleanHeaders } });
  }

  const secret = getSessionSecret();
  if (!secret) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Server is not configured. Set TEMP_PASS (or SESSION_SECRET)." },
        { status: 503 }
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const epoch = token ? await getSessionEpoch() : 0;
  const session = token ? await verifySessionToken(token, epoch) : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Admin gate — only fetch the user record when we need to know isAdmin.
  // Non-admin paths skip this Redis round-trip entirely.
  if (isAdminPath(pathname)) {
    const user = await getUserByEmail(session.email).catch(() => null);
    const adminEmail = getAdminEmail();
    // Treat the configured admin email as admin even if their user record
    // hasn't been bootstrapped yet (first login lazily creates it). This
    // keeps the admin from being locked out of /admin/* on the very first
    // visit before they've actually logged in via /api/login.
    const isAdmin = user?.isAdmin === true || session.email === adminEmail;
    if (!isAdmin) {
      if (pathname.startsWith(ADMIN_API_PREFIX)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // Forward identity to downstream API routes so they don't re-parse the
  // cookie. We start from `cleanHeaders` (caller-supplied value already
  // stripped above) so spoofing isn't possible.
  cleanHeaders.set(USER_EMAIL_HEADER, session.email);
  return NextResponse.next({ request: { headers: cleanHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
