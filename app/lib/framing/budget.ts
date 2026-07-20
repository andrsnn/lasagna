// Shared timing budget for the framer tool loops (research + council). Kept
// in one place so both framers stay in lockstep and the numbers can be reasoned
// about against the host wall clock in a single spot.
//
// Why these exist: the framers drive the Ollama SDK in a multi-round tool loop,
// and the SDK exposes no AbortSignal. The *only* guardrails are (1) the overall
// budget the loop checks between rounds and (2) a per-call deadline wrapping
// each `chat()` / tool call (see withDeadline). Without the per-call cap, one
// slow model turn (e.g. a large model like GLM under load) runs until the host
// kills the whole producer — the Vercel `waitUntil` function at its 120s
// maxDuration, or the Fly worker at its kill timer — *before* the loop can
// write its result event. The resume route then reports the producer "stopped
// responding … server function timed out" and the user's framing card hangs
// until that stale-producer ceiling trips. Bounding each call instead lets the
// loop always finalize and persist a result well inside the wall clock.

// Total wall-clock budget for one framing run, measured from the work
// function's entry (so it covers attachment preprocessing + the tool loop +
// finalize). Sized to sit comfortably under the Vercel `waitUntil` 120s
// maxDuration with slack for the result/meta KV writes; the Fly worker (5min
// kill timer) has even more headroom. Raised from the original 40s so a slow
// model gets room to actually produce scoping questions instead of being
// starved into the "run as-is" fallback.
export const FRAMER_BUDGET_MS = 95_000;

// Time held back at the end of the budget for the finalize call. The finalize
// turn is the one that must emit valid JSON, so it gets a guaranteed slice even
// if the tool-gathering rounds ran long — tool-loop calls are bounded to
// `deadlineAt - FRAMER_FINALIZE_RESERVE_MS`, finalize calls to the full
// `deadlineAt`. Generous (18s) because a slow model's structured-output turn
// can legitimately take that long.
export const FRAMER_FINALIZE_RESERVE_MS = 18_000;

// Hard ceiling on any single `chat()` call regardless of how much budget is
// left. Stops one wedged turn from silently consuming the entire window before
// the loop ever gets to finalize.
export const FRAMER_CALL_HARD_CAP_MS = 55_000;

// Hard ceiling on a single web_search / web_fetch tool call. The framer only
// needs shallow lookups (fetch output is already capped to 4000 chars), so a
// hung fetch shouldn't be allowed to eat the loop budget.
export const FRAMER_TOOL_TIMEOUT_MS = 15_000;
