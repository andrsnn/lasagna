"use client";

// Keep a research app's scheduled task in sync with the app itself. The schedule
// is stored server-side (Redis) and runs without access to the client's app.state,
// so its model/columns/prompt drift out of date - which is how a stale `gemma`
// model and mismatched column keys kept getting used for scheduled runs. Call
// this whenever the research settings are saved: it rewrites the existing
// schedule (preserving its cron) so a scheduled refresh uses the SAME query,
// columns, idKeys and model the manual Refresh does.

import type { ResearchColumn } from "@/app/db";

export async function syncResearchSchedule(
  appId: string,
  cfg: {
    query: string;
    columns: ResearchColumn[];
    idKeys: string[];
    schema: unknown;
    model?: string;
  }
): Promise<void> {
  try {
    const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`);
    if (!r.ok) return; // no schedule registered for this app - nothing to sync
    const snap = (await r.json()) as { task?: { type?: string; cron?: string } };
    const task = snap?.task;
    if (!task || task.type !== "query" || !task.cron) return;
    const next = {
      cron: task.cron,
      type: "query" as const,
      prompt: cfg.query,
      research: true,
      tools: ["web_search"] as ("web_search" | "web_fetch")[],
      model: cfg.model || undefined,
      columns: cfg.columns,
      idKeys: cfg.idKeys,
      schema: cfg.schema,
    };
    await fetch("/api/schedules/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // modelResolved: cfg.model comes from the research settings save, i.e.
      // the app's configured model - this writer may update the stored model.
      body: JSON.stringify({ appId, schedule: next, modelResolved: true }),
    });
  } catch {
    /* best-effort: a failed sync just leaves the old schedule, never blocks save */
  }
}

/**
 * Generic counterpart for non-research apps: after a settings save changes the
 * app's model, push it onto the registered schedule (if any) so the next
 * server-side run uses it even when the account-store lookup can't resolve
 * app.model (local-first apps). Preserves everything else about the task.
 */
export async function syncScheduleModel(
  appId: string,
  model: string | undefined
): Promise<void> {
  try {
    const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`);
    if (!r.ok) return; // no schedule registered - nothing to sync
    const snap = (await r.json()) as {
      task?: { type?: string; model?: string };
      origin?: "manifest" | "sdk";
    };
    const task = snap?.task;
    if (!task || task.type !== "query") return;
    // "Default" (undefined) never clears a stored model - the store preserves
    // the last explicitly-known model rather than letting a scheduled run fall
    // through to the server's hardcoded default.
    if (!model || task.model === model) return;
    await fetch("/api/schedules/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId,
        schedule: { ...task, model },
        origin: snap.origin ?? "manifest",
        modelResolved: true,
      }),
    });
  } catch {
    /* best-effort */
  }
}
