/**
 * Returns a one-line system message stating the current server date.
 * Injected into chat-style routes so models don't reason about "today"
 * using their training cutoff.
 */
export function currentDateSystemLine(now: Date = new Date()): string {
  const fmt = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `The current date is ${fmt} (UTC). Use this when the user asks about "today", recent events, or anything time-relative.`;
}
