// Make a model's "JSON" reply actually parseable. Models ignore `format:"json"`
// in several ways:
//   - Kimi wraps output in ```json … ``` fences.
//   - Reasoning models (MiniMax, DeepSeek, Qwen, GLM) emit a <think>…</think>
//     block before the JSON even with think:false — JSON.parse then dies on the
//     leading "<". This was the "Planner returned non-JSON content: <think>…"
//     research failure.
//   - Some prepend/append prose around the object.
// This strips reasoning + fences and isolates the outermost JSON value so a
// strict JSON.parse downstream succeeds. Pass-through for already-clean JSON.

export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  // Drop closed reasoning blocks anywhere in the payload.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // A dangling/unclosed <think> (truncated thinking) at the start: there's no
  // </think> to anchor on, so fall through to the delimiter slice below.
  s = s.replace(/^<think>/i, "").trim();
  // Strip ```json … ``` fences.
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "").trim();
  // Isolate the outermost JSON object/array if prose/reasoning still surrounds
  // it. First opening delimiter → last matching closing delimiter.
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  let start = -1;
  if (objStart >= 0 && arrStart >= 0) start = Math.min(objStart, arrStart);
  else start = Math.max(objStart, arrStart);
  if (start >= 0) {
    const close = s[start] === "{" ? "}" : "]";
    const end = s.lastIndexOf(close);
    if (end > start) s = s.slice(start, end + 1);
  }
  return s.trim();
}
