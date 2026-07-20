// Builds a *top-level* HTML document for the "full-page screenshot" view of a
// shared artifact.
//
// The normal viewer (app/share/html/[token]/share-html-client.tsx) renders the
// artifact inside a sandboxed <iframe>. That's the right default for security,
// but iOS Safari's native "Full Page" screenshot only expands the *top-level*
// document's scroll height — it can't reach content that scrolls inside an
// embedded iframe. So when a user wants a true full-size capture, we serve the
// artifact HTML as the page document itself: document scroll == artifact
// scroll, and iOS Full Page captures the whole thing.
//
// Dropping the iframe means the SDK (window.artifact) would have no host to
// talk to. To keep SDK-driven *apps* rendering, we inject a tiny same-window
// host shim: in a top-level page `window.parent === window`, so the SDK's
// postMessage traffic loops back to us. The shim answers the `ready` handshake
// (resolving artifact.ready()) and forwards query / fetch / shared.* to the
// same public, rate-limited endpoints the iframe viewer uses.

import { FRAME_NAMESPACE } from "./sdk-protocol";

/**
 * Produce the host-shim <script> that drives an SDK artifact in a top-level
 * (no-iframe) page. `token` scopes the public query/fetch/shared endpoints;
 * `params` are the values the artifact was shared with.
 *
 * The script is emitted as a string for inlining into the document <head>
 * ahead of the SDK so its message listener is installed before the SDK fires
 * its first `ready`.
 */
export function buildScreenshotHostScript(
  token: string,
  params: Record<string, unknown>
): string {
  // JSON.stringify is safe to inline as long as we neutralize the sequence
  // that could close the surrounding <script> early.
  const ns = JSON.stringify(FRAME_NAMESPACE);
  const tokenJson = JSON.stringify(token);
  const paramsJson = JSON.stringify(params ?? {}).replace(/</g, "\\u003c");

  return `(function () {
  var NS = ${ns};
  var TOKEN = ${tokenJson};
  var PARAMS = ${paramsJson};
  var BASE = "/api/share/html/" + encodeURIComponent(TOKEN);
  // Per-viewer state for this page load. artifact.state.* persists only for the
  // session here — a screenshot view is throwaway by nature.
  var STATE = {};

  function post(payload) {
    window.postMessage({ ns: NS, payload: payload }, "*");
  }
  function reply(id, ok, value) {
    post(ok ? { id: id, ok: true, result: value } : { id: id, ok: false, error: String(value) });
  }

  async function rpc(req) {
    switch (req.type) {
      case "query": {
        var r = await fetch(BASE + "/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: req.prompt,
            schema: req.opts && req.opts.schema,
            // Model is never taken from artifact code; the server resolves it.
            webSearch: req.opts && req.opts.webSearch,
            system: req.opts && req.opts.system,
          }),
        });
        var jq = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(jq.error || ("query failed (" + r.status + ")"));
        return jq;
      }
      case "fetch": {
        var rf = await fetch(BASE + "/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: req.url,
            method: req.init && req.init.method,
            headers: req.init && req.init.headers,
            body: req.init && req.init.body,
          }),
        });
        var jf = await rf.json().catch(function () { return {}; });
        if (!rf.ok) throw new Error(jf.error || ("fetch failed (" + rf.status + ")"));
        return jf;
      }
      case "state.get":
        return STATE[req.key] != null ? STATE[req.key] : null;
      case "state.set":
        STATE[req.key] = req.value;
        return true;
      case "open-url": {
        try {
          var u = new URL(String(req.url));
          if (["http:", "https:", "mailto:", "tel:"].indexOf(u.protocol) === -1) {
            throw new Error("blocked URL protocol");
          }
          window.open(u.toString(), req.target === "_top" ? "_top" : "_blank", "noopener,noreferrer");
          return true;
        } catch (e) { throw new Error("artifact.openUrl: " + e.message); }
      }
      case "clipboard-write":
        try { await navigator.clipboard.writeText(String(req.text == null ? "" : req.text)); } catch (e) {}
        return true;
      case "download": {
        // Same-origin top-level page can trigger a real download.
        var content = req.bytes instanceof Uint8Array ? req.bytes : (req.text != null ? req.text : "");
        var blob = new Blob([content], { type: req.mime || "application/octet-stream" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = req.filename || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return true;
      }
      case "shared.list": {
        var rl = await fetch(BASE + "/inputs?collection=" + encodeURIComponent(req.collection), { cache: "no-store" });
        var jl = await rl.json().catch(function () { return {}; });
        if (!rl.ok) throw new Error(jl.error || ("shared.list failed (" + rl.status + ")"));
        return Array.isArray(jl.entries) ? jl.entries : [];
      }
      case "shared.append": {
        var ra = await fetch(BASE + "/inputs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection: req.collection, value: req.value }),
        });
        var ja = await ra.json().catch(function () { return {}; });
        if (!ra.ok) throw new Error(ja.error || ("shared.append failed (" + ra.status + ")"));
        return ja.entry != null ? ja.entry : null;
      }
      case "shared.delete": {
        var rd = await fetch(BASE + "/inputs/" + encodeURIComponent(req.entryId) + "?collection=" + encodeURIComponent(req.collection), { method: "DELETE" });
        var jd = await rd.json().catch(function () { return {}; });
        if (!rd.ok) throw new Error(jd.error || ("shared.delete failed (" + rd.status + ")"));
        return jd.removed === true;
      }
      // Schedules are owner/server-bound — a screenshot view just sees the
      // "no run yet" snapshot rather than an error.
      case "schedule.define":
      case "schedule.get":
      case "schedule.run":
      case "schedule.list":
        return null;
    }
    throw new Error(req.type + " is not available in screenshot mode.");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.ns !== NS || !data.payload) return;
    var req = data.payload;
    if (req.type === "ready") {
      post({ type: "init", params: PARAMS, appId: TOKEN, state: STATE, shareToken: TOKEN, shareMode: "public" });
      return;
    }
    if (req.type === "log") return;
    if (!("id" in req)) return;
    rpc(req).then(
      function (result) { reply(req.id, true, result); },
      function (err) { reply(req.id, false, err && err.message ? err.message : err); }
    );
  });
})();`;
}

/**
 * Compose the final top-level screenshot document from the already-composed
 * (SDK-injected) artifact HTML. Injects:
 *   - a responsive viewport meta (if the artifact didn't set one), so mobile
 *     widths render at device scale rather than a zoomed-out desktop width;
 *   - the host shim, placed first in <head> so its listener beats the SDK's
 *     first `ready`.
 */
export function buildScreenshotDocument(
  composedHtml: string,
  token: string,
  params: Record<string, unknown>
): string {
  const shimTag = `<script>${buildScreenshotHostScript(token, params)}</script>`;
  const needsViewport = !/<meta\s+name=["']viewport["']/i.test(composedHtml);
  const viewportTag = needsViewport
    ? `<meta name="viewport" content="width=device-width, initial-scale=1">`
    : "";
  const head = `${viewportTag}${shimTag}`;

  if (/<head\b[^>]*>/i.test(composedHtml)) {
    return composedHtml.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  }
  if (/<html\b[^>]*>/i.test(composedHtml)) {
    return composedHtml.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${composedHtml}</body></html>`;
}
