import {
  getSnapshot,
  isScheduleStoreConfigured,
  listAllAppsWithSchedules,
  type ScheduleSnapshot,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only listing of every registered schedule with its current snapshot.
 * Drives /admin/schedules. No auth — same posture as the other /api/admin
 * routes; deploy behind whatever gateway you use for the rest of the admin
 * surface.
 */
export async function GET() {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const ids = await listAllAppsWithSchedules();
  const items: Array<{ appId: string; snapshot: ScheduleSnapshot | null }> = [];
  for (const appId of ids) {
    const snapshot = await getSnapshot(appId);
    items.push({ appId, snapshot });
  }
  return Response.json({ count: items.length, items });
}
