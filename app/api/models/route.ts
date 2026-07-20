import {
  CATALOG,
  defaultModelMeta,
  mergeModels,
  type CloudModel,
  type RawOllamaModel,
} from "@/app/models";
import { ollamaClient } from "@/app/lib/ollama/client";
import { runpodClient } from "@/app/lib/runpod/client";
import { withRunpodPrefix } from "@/app/lib/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Returns the live set of models the user can target, merged from every
 * configured provider:
 *   - Ollama Cloud (always tried; gated by OLLAMA_API_KEY)
 *   - RunPod Serverless (only tried when RUNPOD_API_KEY + RUNPOD_ENDPOINT_ID
 *     are set; ids are surfaced with a `runpod:` prefix so the chat router
 *     dispatches them correctly)
 *
 * Curated metadata from the static catalog is overlaid where the bare model
 * name matches; unknown ids fall back to `defaultModelMeta`.
 *
 * Response shape:
 *   {
 *     available: CloudModel[],
 *     catalog: CloudModel[],
 *     fetchedAt: number,
 *     providers: { ollama: ProviderHealth, runpod: ProviderHealth | null },
 *     error?: string,                    // legacy field; only set if every
 *                                         // configured provider failed
 *   }
 *
 * The endpoint returns 200 if AT LEAST ONE provider succeeded, even when
 * another failed — a RunPod-only deployment must still get a usable list.
 * 502 only when everything attempted failed.
 */
type ProviderHealth = { ok: boolean; count: number; error?: string };

const RUNPOD_LIST_TIMEOUT_MS = 5000;

export async function GET(req: Request) {
  const fetchedAt = Date.now();
  const available: CloudModel[] = [];
  const seen = new Set<string>();
  const ollamaHealth: ProviderHealth = { ok: false, count: 0 };
  let runpodHealth: ProviderHealth | null = null;

  // Per-request RunPod endpoint id from the user's Settings (sent as a query
  // param so this remains a GET). Falls back to RUNPOD_ENDPOINT_ID on the
  // server if absent.
  const runpodEndpointParam = new URL(req.url).searchParams
    .get("runpodEndpoint")
    ?.trim();
  const runpodEndpointId = runpodEndpointParam || undefined;

  // -- Ollama Cloud (existing behavior; first so its curated ordering wins).
  try {
    const ollama = ollamaClient();
    try {
      const list = await ollama.list();
      const merged = mergeModels((list.models ?? []) as RawOllamaModel[]);
      for (const m of merged) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        available.push(m);
      }
      ollamaHealth.ok = true;
      ollamaHealth.count = merged.length;
    } catch (err) {
      ollamaHealth.error =
        err instanceof Error ? err.message : "Couldn't reach Ollama Cloud";
    }
  } catch (err) {
    // Missing OLLAMA_API_KEY — surface the message but keep going so a
    // RunPod-only deployment still works.
    ollamaHealth.error =
      err instanceof Error ? err.message : "Ollama unavailable";
  }

  // -- RunPod (when the API key is set AND we have an endpoint id from
  // either the per-user Settings query param or the server env fallback).
  const effectiveRunpodEndpoint =
    runpodEndpointId || process.env.RUNPOD_ENDPOINT_ID;
  if (process.env.RUNPOD_API_KEY && effectiveRunpodEndpoint) {
    runpodHealth = { ok: false, count: 0 };
    try {
      const rp = runpodClient({ endpointId: effectiveRunpodEndpoint });
      const listed = await Promise.race([
        rp.list(),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("RunPod /models timed out after 5s")),
            RUNPOD_LIST_TIMEOUT_MS
          )
        ),
      ]);
      // Suppress the `default` placeholder when the worker also advertises a
      // real model — surfacing both confuses the picker and leads users to
      // pick `default`, which then has to be resolved at chat time. When
      // `default` is the ONLY id, keep it so the picker has something.
      const rawIds = (listed.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      const hasReal = rawIds.some((id) => id !== "default");
      let count = 0;
      for (const bare of rawIds) {
        if (hasReal && bare === "default") continue;
        const prefixed = withRunpodPrefix(bare);
        if (seen.has(prefixed)) continue;
        seen.add(prefixed);
        // RunPod-listed models inherit no curated metadata by default. We
        // synthesize a minimal entry so the picker has a row to render; the
        // user can edit labels via custom-models if desired.
        available.push(defaultModelMeta(prefixed));
        count++;
      }
      runpodHealth.ok = true;
      runpodHealth.count = count;
    } catch (err) {
      runpodHealth.error =
        err instanceof Error ? err.message : "Couldn't reach RunPod";
    }
  }

  const anyOk = ollamaHealth.ok || (runpodHealth?.ok ?? false);
  // Combined error message preserved for the legacy `error` field that older
  // clients read; structured `providers` below is the source of truth going forward.
  const combinedError = anyOk
    ? undefined
    : [ollamaHealth.error, runpodHealth?.error].filter(Boolean).join(" / ") ||
      "No LLM providers reachable";

  return Response.json(
    {
      available,
      catalog: CATALOG,
      fetchedAt,
      providers: { ollama: ollamaHealth, runpod: runpodHealth },
      ...(combinedError ? { error: combinedError } : {}),
    },
    { status: anyOk ? 200 : 502 }
  );
}
