// Realistic, rotating browser User-Agent strings for the web tools.
//
// Why this exists: several sites serve a bot-block, an empty shell, or a stale
// "not available" page when the request doesn't look like a real browser. Our
// tools were the classic tells - http_request sent Node's default (often no UA
// at all), curl/wget announce themselves by name, and browse_page pinned a
// single aging UA (a fixed fingerprint is itself a block signal). Rotating over
// a small pool of current, real desktop-browser UAs makes each request look
// like an ordinary human visit and avoids one static fingerprint getting
// blocklisted.
//
// Two pools:
//  - CHROMIUM_USER_AGENTS: Chromium-family only (Chrome/Edge). Use for
//    browse_page, where the engine really IS Chromium - a Firefox/Safari UA on
//    a Chromium engine mismatches the Sec-CH-UA client hints the browser sends
//    automatically, which is a worse tell than a plausible Chrome UA.
//  - BROWSER_USER_AGENTS: the full mix (adds Firefox + Safari). Use for raw
//    HTTP (http_request, curl/wget), where there's no engine to contradict the
//    string.

/** Chromium-family desktop UAs - safe for a real Chromium (browse_page). */
export const CHROMIUM_USER_AGENTS: readonly string[] = [
  // Chrome on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  // Chrome on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Edge on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
];

/** Full desktop mix (adds Firefox + Safari) - for raw HTTP clients. */
export const BROWSER_USER_AGENTS: readonly string[] = [
  ...CHROMIUM_USER_AGENTS,
  // Firefox on Windows / macOS
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  // Safari on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];

function pick(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
}

/** A random current desktop-browser UA from the full pool (raw HTTP). */
export function randomBrowserUserAgent(): string {
  return pick(BROWSER_USER_AGENTS);
}

/** A random Chromium-family UA - for a real Chromium engine (browse_page). */
export function randomChromiumUserAgent(): string {
  return pick(CHROMIUM_USER_AGENTS);
}

/**
 * Default browser-like request headers to accompany a raw HTTP fetch, keyed
 * lowercase. Includes the rotating UA plus the Accept / Accept-Language /
 * Sec-Fetch set a real navigation sends. Merge UNDER any caller-supplied
 * headers so an explicit override always wins.
 */
export function defaultBrowserHeaders(ua: string = randomBrowserUserAgent()): Record<string, string> {
  return {
    "user-agent": ua,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
  };
}
