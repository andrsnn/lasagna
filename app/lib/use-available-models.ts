"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CATALOG,
  sortModelsForDisplay,
  syntheticRunpodModel,
  type CloudModel,
} from "@/app/models";
import { RUNPOD_PREFIX } from "@/app/lib/llm/provider";

type State = {
  models: CloudModel[];
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
};

// Module-level cache shared by every hook caller — avoids each picker
// hitting /api/models on mount. Refresh() bumps it for everyone.
let cache: State = {
  models: CATALOG,
  fetchedAt: null,
  loading: false,
  error: null,
};
const subscribers = new Set<(s: State) => void>();
let inflight: Promise<void> | null = null;
// Tracks which RunPod endpoint id the cache was last filled with. When the
// user changes their endpoint in Settings we want to drop the cache so the
// list reflects the new endpoint's models.
let cachedRunpodEndpoint: string | null = null;

function publish(next: State) {
  cache = next;
  for (const fn of subscribers) fn(next);
}

async function fetchOnce(runpodEndpoint?: string): Promise<void> {
  if (inflight) return inflight;
  cachedRunpodEndpoint = runpodEndpoint ?? null;
  inflight = (async () => {
    publish({ ...cache, loading: true, error: null });
    try {
      const url = runpodEndpoint
        ? `/api/models?runpodEndpoint=${encodeURIComponent(runpodEndpoint)}`
        : "/api/models";
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as {
        available?: CloudModel[];
        fetchedAt?: number;
        error?: string;
      };
      const baseList =
        Array.isArray(body.available) && body.available.length > 0
          ? body.available
          : CATALOG;
      // Always surface the user's RunPod endpoint as a pickable entry when
      // they've configured one — listings from custom workers are unreliable,
      // and we'd rather let them attempt a chat than have them stranded
      // wondering where their endpoint went.
      const list =
        runpodEndpoint && !baseList.some((m) => m.id.startsWith(RUNPOD_PREFIX))
          ? [...baseList, syntheticRunpodModel(runpodEndpoint)]
          : baseList;
      publish({
        models: list,
        fetchedAt: body.fetchedAt ?? Date.now(),
        loading: false,
        error: res.ok ? null : body.error ?? `Request failed (${res.status})`,
      });
    } catch (err) {
      publish({
        ...cache,
        loading: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useAvailableModels(runpodEndpoint?: string) {
  const [state, setState] = useState<State>(cache);

  // Present a single, repeatable order to every picker. The upstream provider
  // order is unstable (Ollama's `list()` reshuffles between calls), so we sort
  // by label here at the shared source rather than in each consumer. Pickers
  // that group by a recommended set (research/voice) partition this list and
  // re-impose their own order for the recommended rows, so this only fixes the
  // ungrouped "everything else" ordering they were leaving to chance.
  const models = useMemo(
    () => sortModelsForDisplay(state.models),
    [state.models]
  );

  useEffect(() => {
    subscribers.add(setState);
    setState(cache);
    const endpointChanged = (runpodEndpoint ?? null) !== cachedRunpodEndpoint;
    if ((!cache.fetchedAt && !cache.loading) || endpointChanged) {
      void fetchOnce(runpodEndpoint);
    }
    return () => {
      subscribers.delete(setState);
    };
  }, [runpodEndpoint]);

  const refresh = useCallback(
    () => fetchOnce(runpodEndpoint),
    [runpodEndpoint]
  );

  return { ...state, models, refresh };
}
