// Resolve the absolute base URL used to turn relative metadata assets
// (og:image, twitter:image, …) into absolute URLs.
//
// Why this exists: our share pages emit a dynamic OG card via the
// `opengraph-image.tsx` file convention. Next.js turns that into an absolute
// `og:image` URL using `metadataBase`. When `metadataBase` is left unset,
// Next falls back to `VERCEL_PROJECT_PRODUCTION_URL` — the Vercel *project's*
// canonical production domain. This deployment is reachable under more than
// one host (e.g. it's shared from a preview/alias domain while the project's
// production URL is a different `your-project.vercel.app` host), so that
// fallback pins `og:image` to a *different origin* than the page the
// recipient opened.
// Unfurlers like iMessage then fail to load the cross-origin image and drop
// the expanded preview down to a bare link chip (the "image stopped showing"
// bug). Deriving the base from the request host keeps the preview image
// same-origin with the shared link no matter which alias or custom domain
// was used.
//
// Returns `undefined` only when there's no request host to read (e.g. some
// build-time contexts), in which case Next falls back to its own default.

import { headers } from "next/headers";

export async function requestMetadataBase(): Promise<URL | undefined> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? "https";
    try {
      return new URL(`${proto}://${host}`);
    } catch {
      // Malformed host header — fall through to the env-based fallback.
    }
  }
  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) {
    try {
      return new URL(`https://${vercel}`);
    } catch {
      // ignore
    }
  }
  return undefined;
}
