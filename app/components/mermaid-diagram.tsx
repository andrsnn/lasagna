"use client";

// Renders a Mermaid diagram source string to inline SVG. Mermaid is the
// text-based diagram format the note assistant emits for flowcharts, sequence
// diagrams, ER/state charts, etc. — small, accurate, diffable, and editable as
// plain text in the note body. This is a generic platform capability: any
// surface that renders markdown gets diagrams by routing ```mermaid fences
// through here (see CodeBlock).
//
// The mermaid library is heavy (~megabytes with d3/dagre), so it is loaded via
// dynamic import — it only enters the bundle when a diagram is actually on
// screen. Rendering is client-only (mermaid needs a DOM); on error we fall back
// to showing the source so a malformed diagram never blanks the note.

import { useEffect, useId, useRef, useState } from "react";

// Coalesce bursts of source changes into a single render. While the assistant
// STREAMS a diagram into the note, this component is re-rendered on every token
// with a longer, still-malformed source each time. Running mermaid (d3/dagre
// layout) on every one of those partial frames is expensive enough to spike
// memory and crash the browser tab. We instead wait for the source to stop
// changing for this long, then render once. Non-streaming views (reader,
// refresh) settle immediately, so the diagram paints after one short beat.
const RENDER_DEBOUNCE_MS = 250;

// One shared, lazily-created mermaid instance across every diagram on the page.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        // 'strict' sanitizes labels — the source may come from the model, so we
        // never let it inject markup/scripts into the rendered SVG.
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Read the app's current theme. Dark mode is a `.dark` class on <html>. */
function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function MermaidDiagram({ code }: { code: string }) {
  // useId is stable across renders and unique per instance; mermaid rejects
  // ids containing ":" (React's separator), so strip them.
  const reactId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState<boolean>(isDarkMode);
  // True once a diagram has ever rendered for this instance. Used to keep the
  // last good SVG on screen (instead of blanking or flashing an error) while a
  // debounced re-render is pending — e.g. between streamed edits.
  const hasRenderedRef = useRef(false);

  // Re-theme when the user toggles light/dark so diagram colors track the note.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => setDark(isDarkMode()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = code.trim();
    if (!source) {
      hasRenderedRef.current = false;
      setSvg(null);
      setError(null);
      return;
    }
    // Debounce: only render after the source has been stable for a beat. A
    // fresh timer is scheduled on every change, so a stream of edits collapses
    // into one render once it stops. clearTimeout on cleanup cancels a pending
    // render the moment the source changes again.
    const timer = setTimeout(() => {
      void (async () => {
        // Stable id per instance+theme so repeated attempts reuse (not multiply)
        // mermaid's temporary working node.
        const renderId = `mmd-${reactId}-${dark ? "d" : "l"}`;
        try {
          const mermaid = await loadMermaid();
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            fontFamily: "inherit",
            theme: dark ? "dark" : "default",
          });
          // Validate BEFORE rendering. mermaid.render() leaves an orphaned
          // working <div> in <body> whenever it throws — and while the assistant
          // streams a diagram, the still-unclosed ```mermaid fence feeds us a
          // long stream of malformed partials. Rendering each one would pile up
          // orphan DOM until a low-memory (mobile) tab is killed. parse() checks
          // syntax without touching the DOM, so we only ever render valid source.
          const valid = await mermaid.parse(source, { suppressErrors: true });
          if (cancelled) return;
          if (!valid) {
            // Not (yet) a complete, valid diagram. Keep the last good render if
            // we have one; only surface the error card when there's nothing to
            // show — this is a settled failure, not a mid-stream partial.
            if (hasRenderedRef.current) return;
            setSvg(null);
            setError("Could not render diagram.");
            return;
          }
          const { svg: out } = await mermaid.render(renderId, source);
          if (cancelled) return;
          hasRenderedRef.current = true;
          setSvg(out);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          if (hasRenderedRef.current) return;
          setSvg(null);
          setError(err instanceof Error ? err.message : "Could not render diagram.");
        } finally {
          // Belt-and-suspenders: remove any working node mermaid may have left
          // behind (id, or the `d`-prefixed variant it uses internally) so a
          // failed render can never leak DOM into the page.
          if (typeof document !== "undefined") {
            document
              .querySelectorAll(`#${renderId}, #d${renderId}`)
              .forEach((n) => n.remove());
          }
        }
      })();
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, dark, reactId]);

  // Error / not-yet-rendered fallback: show the source so the note never blanks.
  if (error) {
    return (
      <div className="not-prose my-4 overflow-hidden rounded-lg border border-amber-400/40 bg-amber-400/5">
        <div className="border-b border-amber-400/30 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Diagram couldn’t render — showing source
        </div>
        <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed">
          <code>{code.trim()}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      // not-prose keeps typography styles off the SVG; center the diagram and
      // clamp it to the content width so it stays "small" and never overflows.
      className="not-prose my-4 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Reserve a little height while the async render is in flight so the note
      // doesn't jump when the SVG lands.
      style={svg ? undefined : { minHeight: "2rem" }}
      // The SVG is produced by mermaid with securityLevel:"strict" (sanitized).
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
