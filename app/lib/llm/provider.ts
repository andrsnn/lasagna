// Provider routing primitives. The single source of truth for "which upstream
// LLM service handles this model id?" — used by every callsite that needs to
// pick between Ollama Cloud and a RunPod Serverless endpoint.
//
// Convention: a literal `runpod:` prefix on the model id means "send this to
// RunPod"; everything else routes to Ollama Cloud. Splitting on the FIRST
// colon only preserves Ollama-style tags such as `gpt-oss:120b`.
//
// Pure helpers — no I/O, no env var reads. Safe to import anywhere
// (including the client bundle and the artifact stream parser).

export type Provider = "ollama" | "runpod";

export const RUNPOD_PREFIX = "runpod:";

export function providerFor(id: string): Provider {
  return id.startsWith(RUNPOD_PREFIX) ? "runpod" : "ollama";
}

/** Strip the `runpod:` prefix so the upstream call carries the bare model id. */
export function upstreamModelId(id: string): string {
  return id.startsWith(RUNPOD_PREFIX) ? id.slice(RUNPOD_PREFIX.length) : id;
}

/** Add the `runpod:` prefix if missing. Idempotent. */
export function withRunpodPrefix(id: string): string {
  return id.startsWith(RUNPOD_PREFIX) ? id : RUNPOD_PREFIX + id;
}
