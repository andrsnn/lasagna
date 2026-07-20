// Minimal SSE consumer for `/api/chat/resume/{streamId}`. Only cares about
// `delta` (accumulates `data.text`), `done` (terminal), and `error` (throws).
// TODO: the canonical implementation lives in `consumeChatStream` in
// `app/components/chat.tsx` — if new terminal events appear server-side,
// mirror them here.
export async function consumeDeltasOnly(
  streamId: string,
  signal: AbortSignal,
  onDelta?: (full: string) => void
): Promise<string> {
  const res = await fetch(
    `/api/chat/resume/${encodeURIComponent(streamId)}?cursor=0`,
    { headers: { Accept: "text/event-stream" }, signal }
  );
  if (!res.ok || !res.body) {
    throw new Error(`resume ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  try {
    outer: while (true) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        if (event === "delta" && typeof data.text === "string") {
          full += data.text;
          onDelta?.(full);
        } else if (event === "error") {
          const msg = typeof data.message === "string" ? data.message : "stream error";
          throw new Error(msg);
        } else if (event === "done") {
          break outer;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return full;
}
