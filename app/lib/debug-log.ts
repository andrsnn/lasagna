"use client";

// On-device diagnostics that SURVIVE a browser tab crash.
//
// The mobile chat crash ("This page couldn't load") kills the WebKit tab, so
// nothing logged in-page or to the console can be recovered afterward. The fix
// is to write breadcrumbs to localStorage *synchronously* as the page renders:
// localStorage.setItem lands before the crash, so after the tab dies and the
// user reloads, the LAST breadcrumb tells us exactly which phase blew up
// (loading messages? rendering? decoding image #8?) instead of us guessing.
//
// Everything here is a no-op unless the user flips "Phone debug mode" on in
// Preferences, so it costs nothing in normal use. Backed by localStorage (not
// the async IDB Settings table) because breadcrumb writes must be synchronous
// and the flag must be readable synchronously during render.

const ENABLED_KEY = "artifacts.debug.enabled";
const SAFE_KEY = "artifacts.debug.safeRender";
const TRAIL_KEY = "artifacts.debug.trail";
const MAX_TRAIL = 400;

export type Crumb = { t: number; label: string; data?: unknown };

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isDebugEnabled(): boolean {
  return ls()?.getItem(ENABLED_KEY) === "1";
}

export function setDebugEnabled(on: boolean): void {
  try {
    ls()?.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  if (on) {
    installGlobalHandlers();
    dbg("debug.enabled", deviceInfo());
  }
}

/**
 * Safe-render bisect: when on, the transcript skips decoding attached image
 * bytes entirely (renders a placeholder). If the chat then opens, images are
 * the crash cause and we've proven it on-device. If it still crashes, images
 * are NOT the cause and we look elsewhere.
 */
export function isSafeRender(): boolean {
  return ls()?.getItem(SAFE_KEY) === "1";
}

export function setSafeRender(on: boolean): void {
  try {
    ls()?.setItem(SAFE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function dbg(label: string, data?: unknown): void {
  const store = ls();
  if (!store || store.getItem(ENABLED_KEY) !== "1") return;
  const crumb: Crumb = { t: Date.now(), label, data };
  // Durable first: a SYNCHRONOUS post to the server. localStorage alone does
  // NOT survive an iOS OOM tab-kill (WebKit flushes it to disk lazily), so the
  // last breadcrumbs before the crash would be lost. A sync XHR blocks until
  // the server has the crumb, so it's safe even if the tab dies the next
  // instant. Yes, sync XHR is deprecated and blocks the main thread - that's
  // an acceptable price in an opt-in debug session, and slightly slowing the
  // render can itself be a useful signal.
  sendCrumbSync(crumb);
  try {
    const raw = store.getItem(TRAIL_KEY);
    const arr: Crumb[] = raw ? (JSON.parse(raw) as Crumb[]) : [];
    arr.push(crumb);
    if (arr.length > MAX_TRAIL) arr.splice(0, arr.length - MAX_TRAIL);
    store.setItem(TRAIL_KEY, JSON.stringify(arr));
  } catch {
    /* quota / serialization — losing a breadcrumb is fine */
  }
  try {
    console.log("[dbg]", label, data ?? "");
  } catch {
    /* ignore */
  }
}

function sendCrumbSync(crumb: Crumb): void {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/debug/log", false); // false = synchronous
    xhr.setRequestHeader("content-type", "application/json");
    xhr.send(JSON.stringify(crumb));
  } catch {
    /* offline / blocked — localStorage is the fallback */
  }
}

/** Fetch the durable server-side trail (survives crashes; readable anywhere). */
export async function fetchServerTrail(): Promise<Crumb[]> {
  try {
    const res = await fetch("/api/debug/trail", { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { trail?: Crumb[] };
    return Array.isArray(body.trail) ? body.trail : [];
  } catch {
    return [];
  }
}

/** Clear both the local and durable trails. */
export async function clearServerTrail(): Promise<void> {
  try {
    await fetch("/api/debug/trail", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

export function readTrail(): Crumb[] {
  try {
    const raw = ls()?.getItem(TRAIL_KEY);
    return raw ? (JSON.parse(raw) as Crumb[]) : [];
  } catch {
    return [];
  }
}

export function clearTrail(): void {
  try {
    ls()?.removeItem(TRAIL_KEY);
  } catch {
    /* ignore */
  }
}

export function deviceInfo(): Record<string, unknown> {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & {
    deviceMemory?: number;
  };
  const perf = (typeof performance !== "undefined"
    ? (performance as Performance & {
        memory?: {
          usedJSHeapSize: number;
          totalJSHeapSize: number;
          jsHeapSizeLimit: number;
        };
      })
    : undefined);
  const mem = perf?.memory;
  return {
    ua: nav.userAgent,
    deviceMemoryGB: nav.deviceMemory ?? "n/a",
    cores: nav.hardwareConcurrency ?? "n/a",
    screen:
      typeof screen !== "undefined"
        ? `${screen.width}x${screen.height}@${
            typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1
          }`
        : "n/a",
    // Blink-only; on iOS WebKit this is absent, which is itself a useful signal.
    jsHeapMB: mem
      ? {
          used: Math.round(mem.usedJSHeapSize / 1048576),
          limit: Math.round(mem.jsHeapSizeLimit / 1048576),
        }
      : "n/a (WebKit)",
  };
}

/** Record current JS-heap usage if the browser exposes it (Blink only). */
export function dbgMem(label: string): void {
  if (!isDebugEnabled()) return;
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  };
  const mem = perf?.memory;
  dbg(
    label,
    mem
      ? {
          usedMB: Math.round(mem.usedJSHeapSize / 1048576),
          limitMB: Math.round(mem.jsHeapSizeLimit / 1048576),
        }
      : "heap n/a"
  );
}

let installed = false;
/** Capture uncaught errors / rejections / lifecycle into the trail. Idempotent. */
export function installGlobalHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) =>
    dbg("window.error", {
      msg: String(e.message),
      src: e.filename,
      line: e.lineno,
      col: e.colno,
    })
  );
  window.addEventListener("unhandledrejection", (e) =>
    dbg("unhandledrejection", {
      reason: String((e as PromiseRejectionEvent).reason),
    })
  );
  window.addEventListener("pagehide", () => dbg("pagehide"));
  document.addEventListener("visibilitychange", () =>
    dbg("visibilitychange", { state: document.visibilityState })
  );
}
