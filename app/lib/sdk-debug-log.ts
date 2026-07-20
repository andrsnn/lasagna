import { useSyncExternalStore } from "react";

export type SdkEvent = {
  id: string;
  at: number;
  direction: "iframe-to-host" | "host-to-iframe";
  type: string;
  payload: unknown;
  durationMs?: number;
  response?: { ok: boolean; result?: unknown; error?: string };
};

const MAX_EVENTS = 200;
// Persist the log per-app so it survives a reload ("kick off a run, close the
// phone, come back" — the completed run should still be in the log). Capped in
// bytes because a deep-research result payload can be large.
const LS_PREFIX = "ollchat:sdklog:";
const MAX_PERSIST_BYTES = 1_500_000;

type Store = {
  events: SdkEvent[];
  version: number;
};

const stores = new Map<string, Store>();
const listeners = new Map<string, Set<() => void>>();

function lsKey(appId: string): string {
  return LS_PREFIX + appId;
}

function loadPersisted(appId: string): SdkEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(lsKey(appId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as SdkEvent[]).slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persist(appId: string, events: SdkEvent[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    let slice = events.slice(-MAX_EVENTS);
    let json = JSON.stringify(slice);
    // Drop oldest in chunks until under the byte cap so one huge result payload
    // can't blow the per-origin localStorage quota.
    while (json.length > MAX_PERSIST_BYTES && slice.length > 1) {
      slice = slice.slice(Math.ceil(slice.length / 4));
      json = JSON.stringify(slice);
    }
    localStorage.setItem(lsKey(appId), json);
  } catch {
    // Quota or serialization failure — in-memory log still works.
  }
}

function getStore(appId: string): Store {
  let s = stores.get(appId);
  if (!s) {
    s = { events: loadPersisted(appId), version: 0 };
    stores.set(appId, s);
  }
  return s;
}

function notify(appId: string) {
  listeners.get(appId)?.forEach((fn) => fn());
}

export function pushSdkEvent(appId: string, event: SdkEvent): void {
  const s = getStore(appId);
  s.events = [...s.events, event].slice(-MAX_EVENTS);
  s.version += 1;
  persist(appId, s.events);
  notify(appId);
}

export function updateSdkEventResponse(
  appId: string,
  eventId: string,
  response: SdkEvent["response"],
  durationMs: number
): void {
  const s = getStore(appId);
  const idx = s.events.findIndex((e) => e.id === eventId);
  if (idx < 0) return;
  const updated = { ...s.events[idx], response, durationMs };
  s.events = [...s.events];
  s.events[idx] = updated;
  s.version += 1;
  persist(appId, s.events);
  notify(appId);
}

export function clearSdkEvents(appId: string): void {
  const s = getStore(appId);
  s.events = [];
  s.version += 1;
  persist(appId, s.events);
  notify(appId);
}

export function useSdkDebugLog(appId: string): SdkEvent[] {
  const subscribe = (cb: () => void) => {
    let set = listeners.get(appId);
    if (!set) {
      set = new Set();
      listeners.set(appId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) listeners.delete(appId);
    };
  };
  const getSnapshot = () => getStore(appId).events;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
