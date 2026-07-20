"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCachedImage, putCachedImage } from "./image-cache";

// React glue over app/lib/image-cache.ts. Given a (typically `/api/img`-proxied)
// image URL, it downloads the bytes once, persists them in IndexedDB, and serves
// the image from a local blob URL so a transient upstream/edge flake can't make
// an already-shown image "randomly break". On a cache hit nothing touches the
// network at all.
//
// Returns the `src` to feed the <img> plus an `onError` handler to wire to it:
// if the live network src breaks before we managed to capture the bytes, the
// handler makes one last attempt to recover from the cache.

/**
 * Only same-origin URLs (which is where the `/api/img` proxy lives - the source
 * of the flaky-load bug) are cached. Cross-origin images generally can't be
 * read as bytes due to CORS, so we leave them on the native <img> path exactly
 * as before. data:/blob: URLs are already local and need no caching.
 */
function isCacheableImageUrl(src: string): boolean {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return false;
  if (typeof window === "undefined") return false;
  try {
    const u = new URL(src, window.location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function useCachedImage(
  rawSrc: string | undefined,
  enabled = true
): { src: string | undefined; onError: () => void } {
  const [displaySrc, setDisplaySrc] = useState(rawSrc);
  // Object URL we minted and are responsible for revoking.
  const objectUrlRef = useRef<string | null>(null);
  // Once we serve local bytes the displayed src can't break, so onError stops
  // trying to recover.
  const servingLocalRef = useRef(false);

  const revoke = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    servingLocalRef.current = false;
    revoke();
    setDisplaySrc(rawSrc);

    if (!enabled || !rawSrc || !isCacheableImageUrl(rawSrc)) return;

    const serveBlob = (blob: Blob) => {
      const obj = URL.createObjectURL(blob);
      objectUrlRef.current = obj;
      servingLocalRef.current = true;
      setDisplaySrc(obj);
    };

    void (async () => {
      // 1) Already downloaded? Serve the local copy and skip the network.
      const cached = await getCachedImage(rawSrc).catch(() => null);
      if (cancelled) return;
      if (cached) {
        serveBlob(cached);
        return;
      }
      // 2) Download the bytes ourselves so the displayed src is a stable local
      //    blob, then persist them. Any failure (CORS, offline, non-image) just
      //    leaves the original network src in the <img>, i.e. prior behavior.
      try {
        const res = await fetch(rawSrc, { cache: "force-cache" });
        if (cancelled || !res.ok) return;
        const blob = await res.blob();
        if (cancelled || !blob.size || !blob.type.startsWith("image/")) return;
        void putCachedImage(rawSrc, blob);
        serveBlob(blob);
      } catch {
        // Keep the network src; the <img> loads it natively.
      }
    })();

    return () => {
      cancelled = true;
      revoke();
    };
  }, [rawSrc, enabled, revoke]);

  // The live network src broke before we captured it - make one last attempt to
  // swap in a cached copy (e.g. it was downloaded on a previous mount).
  const onError = useCallback(() => {
    if (servingLocalRef.current || !rawSrc || !isCacheableImageUrl(rawSrc)) return;
    void getCachedImage(rawSrc)
      .then((blob) => {
        if (!blob) return;
        const obj = URL.createObjectURL(blob);
        objectUrlRef.current = obj;
        servingLocalRef.current = true;
        setDisplaySrc(obj);
      })
      .catch(() => {});
  }, [rawSrc]);

  return { src: displaySrc, onError };
}
