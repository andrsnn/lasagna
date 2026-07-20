// Picks the best-fit app template for a free-text "describe the app you want"
// request, and proposes a short title. Powers the chat-first app-creation flow:
// the user types what they want, the AI seeds a known-good scaffold, and the
// designer chat opens prefilled with the request so the assistant customizes
// from there. Falls back to the blank template if the model misbehaves, so the
// caller always gets a usable result.

import { SHARE_QUERY_DEFAULT_MODEL } from "@/app/models";
import { executeQuery } from "@/app/lib/executors";
import { APP_TEMPLATES, DEFAULT_TEMPLATE_ID, isAppTemplateId } from "@/app/lib/app-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { description?: string; model?: string };

const TEMPLATE_IDS = APP_TEMPLATES.map((t) => t.id);

const CATALOG = APP_TEMPLATES.map(
  (t) => `- ${t.id}: ${t.label}. ${t.description} Best for: ${t.bestFor}`
).join("\n");

const SYSTEM =
  "You route a user's app idea to the single best-fit starter template, and name " +
  "the app. The templates:\n" +
  CATALOG +
  "\n\nPick the ONE template whose shape most closely matches what the user " +
  "describes. Prefer a specific template (tracker, dashboard, digest, events) over 'blank' " +
  "whenever the idea plausibly fits it - blank is only for ideas that genuinely " +
  "don't match any other template. The title is a short, human app name (2-4 " +
  "words, Title Case, no quotes).";

const SCHEMA = {
  type: "object",
  properties: {
    templateId: { type: "string", enum: TEMPLATE_IDS },
    title: { type: "string" },
  },
  required: ["templateId", "title"],
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return Response.json({ error: "description is required." }, { status: 400 });
  }

  // A small, fast, JSON-reliable model — template routing should feel instant,
  // not take the 50s a frontier model spends.
  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : SHARE_QUERY_DEFAULT_MODEL;

  // Never block app creation on a model hiccup: default to blank + a title
  // derived from the request so the UI can always proceed.
  const fallbackTitle = description.split(/\s+/).slice(0, 4).join(" ").slice(0, 40) || "New app";

  try {
    const outcome = await executeQuery({
      prompt: `The user wants an app: "${description}". Choose the best template and a title.`,
      schema: SCHEMA,
      model,
      system: SYSTEM,
    });
    const json =
      outcome.status >= 200 && outcome.status < 300
        ? ((outcome.payload as { json?: unknown }).json as
            | { templateId?: unknown; title?: unknown }
            | undefined)
        : undefined;
    const templateId = isAppTemplateId(json?.templateId) ? json!.templateId : DEFAULT_TEMPLATE_ID;
    const rawTitle = typeof json?.title === "string" ? json.title.trim() : "";
    const title = (rawTitle || fallbackTitle).slice(0, 60);
    return Response.json({ templateId, title });
  } catch {
    return Response.json({ templateId: DEFAULT_TEMPLATE_ID, title: fallbackTitle });
  }
}
