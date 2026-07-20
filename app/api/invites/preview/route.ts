// Public endpoint that confirms an invite token is currently valid without
// consuming it. The signup page hits this on load so it can show "Invalid
// or expired invite" before the user types anything.
//
// Returning only "valid: true/false" (no createdBy, no expiresAt) keeps an
// unauthenticated probe from learning anything more than yes/no.

import { isUserStoreConfigured, peekInvite } from "@/app/lib/user-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isUserStoreConfigured()) {
    return Response.json(
      { valid: false, error: "Sign-up is unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return Response.json({ valid: false }, { status: 400 });
  }
  const invite = await peekInvite(token);
  return Response.json({ valid: invite != null });
}
