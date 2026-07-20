// rAF-batched persistence for high-frequency writes (e.g. assistant streaming
// into the messages store). Caller supplies a key (used for de-dupe) and the
// writer fn; we coalesce writes by key inside a single animation frame.

type Writer<T> = (item: T) => void | Promise<void>;

export function makeWriteScheduler<T>(write: Writer<T>) {
  const pending = new Map<string, T>();
  let raf: number | null = null;

  function flush() {
    raf = null;
    const items = Array.from(pending.values());
    pending.clear();
    for (const item of items) {
      void write(item);
    }
  }

  return {
    schedule(key: string, item: T) {
      pending.set(key, item);
      if (raf !== null) return;
      if (typeof requestAnimationFrame === "undefined") {
        raf = setTimeout(flush, 16) as unknown as number;
      } else {
        raf = requestAnimationFrame(flush);
      }
    },
    flushNow() {
      if (raf !== null) {
        if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf);
        else clearTimeout(raf as unknown as number);
        raf = null;
      }
      flush();
    },
  };
}
