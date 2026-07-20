// Registry of app templates surfaced in the "New" menu and the AI app picker.
// Metadata only — the actual scaffold files live in app/lib/create.ts (keyed by
// these ids), so this module stays a pure, client-safe import for the picker UI.
//
// Picking a template seeds the new app's virtual file system with a working
// scaffold; the assistant then edits it in the chat like any other app. Starting
// from a real, known-good scaffold (instead of a blank canvas) is what makes
// app-building reliable — the model customizes code that already builds and runs
// rather than re-deriving the whole contract from scratch.
//
// Add a template by appending an entry here AND a matching files entry in
// create.ts's TEMPLATE_SCAFFOLDS, then extending the id union + isAppTemplateId.

export type AppTemplateId = "blank" | "digest" | "tracker" | "dashboard" | "events";

export type AppTemplateMeta = {
  id: AppTemplateId;
  label: string;
  description: string;
  /** One-line hint for the AI picker about when this template fits. */
  bestFor: string;
  /** lucide-react icon name, resolved in the picker. */
  icon: "Sparkles" | "Newspaper" | "ListChecks" | "LayoutDashboard" | "CalendarClock";
};

export const APP_TEMPLATES: readonly AppTemplateMeta[] = [
  {
    id: "tracker",
    label: "Tracker / list",
    description:
      "Add items, change their status, and see the live count on a home widget. Saves automatically.",
    bestFor:
      "Any personal list or tracker the user maintains by hand: tasks, habits, job applications, reading, inventory, goals.",
    icon: "ListChecks",
  },
  {
    id: "dashboard",
    label: "Live dashboard",
    description:
      "Metric cards from a web search on a topic that refresh daily on a schedule, with a home widget.",
    bestFor:
      "Glanceable numbers about a topic that change over time and should stay fresh on their own: markets, prices, stats, trends, a company or product to watch.",
    icon: "LayoutDashboard",
  },
  {
    id: "digest",
    label: "Daily web digest",
    description:
      "A recurring web search that returns a structured, scannable list of fresh items on a topic.",
    bestFor:
      "A feed of fresh links/items on a topic that should refresh on its own: news, releases, papers, listings.",
    icon: "Newspaper",
  },
  {
    id: "events",
    label: "Upcoming events",
    description:
      "A recurring web search for dated events that accumulates into a calendar - new events merge in, duplicates are ignored, and past events drop off. Home widget shows what's next.",
    bestFor:
      "A forward-looking calendar of dated happenings on a topic that should build up over time instead of resetting: local events, sales/auctions, concerts, conferences, deadlines, releases.",
    icon: "CalendarClock",
  },
  {
    id: "blank",
    label: "Blank app",
    description: "An empty canvas. Describe what you want and the assistant builds it.",
    bestFor:
      "Anything that doesn't fit the other templates - a custom tool, calculator, game, or visualization.",
    icon: "Sparkles",
  },
];

export const DEFAULT_TEMPLATE_ID: AppTemplateId = "blank";

const TEMPLATE_IDS = new Set<AppTemplateId>(["blank", "digest", "tracker", "dashboard", "events"]);

export function isAppTemplateId(v: unknown): v is AppTemplateId {
  return typeof v === "string" && TEMPLATE_IDS.has(v as AppTemplateId);
}
