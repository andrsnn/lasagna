// Race a thunk against a wall-clock deadline (and an optional per-call hard
// cap). Shared by every server path that drives the Ollama SDK in a loop —
// the SDK exposes no AbortSignal, so a single wedged or just-slow `chat()` /
// `web_fetch` call would otherwise run until the host (Vercel function wall
// clock or Fly kill timer) kills the whole producer mid-flight, before it can
// write its result. Bounding each call instead converts that silent
// host-level kill into a fast, labelled timeout the caller can fall back on.
//
// Note: this does NOT cancel the underlying work — once Promise.race stops
// awaiting it the leaked task keeps running until the function exits. The
// point is to stop *waiting* on it so the caller can finalize and persist a
// result within its budget.

/**
 * Run `call()` but reject with a labelled timeout if it hasn't settled by
 * `deadline` (epoch ms) or after `hardCapMs`, whichever is sooner. The label
 * flows into the error message so the caller's surfaced error names the step
 * that gave up.
 *
 * Typed `<F extends () => unknown>` (mirroring router.withRetry) so an
 * overloaded `chat()` return type flows through `ReturnType<F>` without
 * collapsing to `unknown`.
 */
export function withDeadline<F extends () => unknown>(
  call: F,
  deadline: number,
  label: string,
  hardCapMs: number = Number.POSITIVE_INFINITY
): Promise<Awaited<ReturnType<F>>> {
  const ms = Math.min(deadline - Date.now(), hardCapMs);
  if (ms <= 0) {
    return Promise.reject(new Error(`${label} timed out`));
  }
  return new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(call() as Promise<Awaited<ReturnType<F>>>).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
