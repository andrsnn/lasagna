"use client";

// Shared infrastructure for tile mini-previews.
//
// 1. Single IntersectionObserver — every AppTile registers via the hook
//    below. This is much cheaper than per-tile observers when the grid is
//    large. Visibility drives both lazy Gemma calls AND iframe mounting.
// 2. Mount semaphore — caps the number of live iframes in the DOM at 6 so
//    a long list doesn't pile up renderers off-screen. Tiles past the cap
//    sit in a queue and mount as earlier ones unmount.

import { useEffect, useRef, useState } from "react";

const MAX_LIVE_IFRAMES = 6;

let observer: IntersectionObserver | null = null;
const visibilityCallbacks = new WeakMap<Element, (visible: boolean) => void>();

function getObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
    return null;
  }
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cb = visibilityCallbacks.get(entry.target);
        if (cb) cb(entry.isIntersecting);
      }
    },
    { rootMargin: "200px" }
  );
  return observer;
}

let activeMounts = 0;
const mountWaiters: Array<() => void> = [];

function tryAcquireMountSlot(grant: () => void) {
  if (activeMounts < MAX_LIVE_IFRAMES) {
    activeMounts += 1;
    grant();
  } else {
    mountWaiters.push(grant);
  }
}

function releaseMountSlot() {
  activeMounts = Math.max(0, activeMounts - 1);
  while (activeMounts < MAX_LIVE_IFRAMES && mountWaiters.length > 0) {
    const next = mountWaiters.shift();
    if (next) {
      activeMounts += 1;
      next();
    }
  }
}

/**
 * Hook controlling tile-level lazy behaviors.
 *
 * Returns `{ ref, visible, shouldMount }`:
 *   - Attach `ref` to the tile's outer container.
 *   - `visible` flips true the first time the element intersects the
 *     viewport (rootMargin 200px) and stays true thereafter — used to
 *     trigger one-shot Gemma tagline generation.
 *   - `shouldMount` is gated by both `wantPreview` and the global iframe
 *     semaphore. It flips back to false when the element scrolls away,
 *     releasing the slot.
 */
export function useTilePreview<T extends Element>(wantPreview: boolean) {
  const ref = useRef<T | null>(null);
  const [shouldMount, setShouldMount] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const visibleRef = useRef(false);
  const ownsSlotRef = useRef(false);
  const queuedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    const obs = getObserver();
    if (!el || !obs) return;

    const onVisibility = (visible: boolean) => {
      visibleRef.current = visible;
      if (visible) setHasBeenVisible(true);

      if (!wantPreview) return;

      if (visible) {
        if (ownsSlotRef.current || queuedRef.current) return;
        queuedRef.current = true;
        tryAcquireMountSlot(() => {
          queuedRef.current = false;
          if (!visibleRef.current) {
            releaseMountSlot();
            return;
          }
          ownsSlotRef.current = true;
          setShouldMount(true);
        });
      } else if (ownsSlotRef.current) {
        ownsSlotRef.current = false;
        setShouldMount(false);
        releaseMountSlot();
      }
    };

    visibilityCallbacks.set(el, onVisibility);
    obs.observe(el);

    return () => {
      visibilityCallbacks.delete(el);
      obs.unobserve(el);
      if (ownsSlotRef.current) {
        ownsSlotRef.current = false;
        releaseMountSlot();
      }
    };
  }, [wantPreview]);

  return { ref, visible: hasBeenVisible, shouldMount } as const;
}
