// Relying Party (RP) configuration for WebAuthn / passkeys.
//
// A passkey is bound to an "RP ID" — the registrable domain the credential
// belongs to — and every ceremony (register / authenticate) is checked
// against an expected origin (scheme + host). Both are derived from the
// incoming request so the same code works on localhost, *.fly.dev,
// *.vercel.app, and a custom domain without per-environment config.
//
// Env overrides exist for the rare case where the browser-visible origin
// differs from the Host header the server sees (e.g. an odd proxy setup):
//   RP_ID      — the registrable domain, no scheme/port (e.g. "example.com")
//   RP_ORIGIN  — the full expected origin (e.g. "https://example.com")
//   RP_NAME    — user-visible service name shown in the OS passkey prompt

const DEFAULT_RP_NAME = "Lasagna";

/**
 * Short-lived HttpOnly cookie that carries the opaque `flowId` for an
 * in-progress passkey login. Login is unauthenticated, so we can't key the
 * challenge by email — instead the flowId ties this browser's
 * /login/options call to its /login/verify call.
 */
export const PASSKEY_AUTH_COOKIE = "pk_auth";

export function getRpName(): string {
  const n = process.env.RP_NAME;
  return n && n.length > 0 ? n : DEFAULT_RP_NAME;
}

/** First host from the forwarded/host header (proxies may append a list). */
function hostFromRequest(req: Request): string | null {
  const raw =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

function isLocalHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]";
}

/**
 * The RP ID must equal the effective domain the credential is scoped to —
 * the host with any port stripped. `localhost` is a valid RP ID for local
 * development (browsers special-case it as a secure context).
 */
export function getRpID(req: Request): string {
  const explicit = process.env.RP_ID;
  if (explicit && explicit.length > 0) return explicit;
  const host = hostFromRequest(req);
  if (!host) return "localhost";
  return host.replace(/:\d+$/, "");
}

/**
 * The expected origin the ceremony must have run on — must match what the
 * browser reports in `clientDataJSON.origin` exactly (scheme + host + port).
 */
export function getExpectedOrigin(req: Request): string {
  const explicit = process.env.RP_ORIGIN;
  if (explicit && explicit.length > 0) return explicit;
  const host = hostFromRequest(req);
  if (!host) return "http://localhost:3000";
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const proto =
    forwardedProto?.split(",")[0]?.trim() || (isLocalHost(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Derive a friendly device name from the User-Agent + transports, used to
 * label a freshly-enrolled passkey ("iPhone", "Mac · Chrome") so a user with
 * several devices can tell them apart. Best-effort; users can rename later.
 */
export function deviceNameFromUserAgent(
  ua: string | null,
  transports?: string[]
): string {
  const t = ua ?? "";
  let os = "Device";
  if (/iphone/i.test(t)) os = "iPhone";
  else if (/ipad/i.test(t)) os = "iPad";
  else if (/android/i.test(t)) os = "Android";
  else if (/mac os x|macintosh/i.test(t)) os = "Mac";
  else if (/windows/i.test(t)) os = "Windows";
  else if (/cros/i.test(t)) os = "ChromeOS";
  else if (/linux/i.test(t)) os = "Linux";

  // A cross-device (hybrid/"cable") ceremony means the user scanned a QR with
  // a phone — label it as such rather than by the browser it was scanned from.
  if (transports?.includes("hybrid") || transports?.includes("cable")) {
    return os === "Device" ? "Phone or tablet" : `${os} (phone)`;
  }

  let browser = "";
  if (/edg\//i.test(t)) browser = "Edge";
  else if (/opr\//i.test(t) || /opera/i.test(t)) browser = "Opera";
  else if (/chrome\//i.test(t)) browser = "Chrome";
  else if (/firefox\//i.test(t)) browser = "Firefox";
  else if (/safari\//i.test(t)) browser = "Safari";

  return browser ? `${os} · ${browser}` : os;
}
