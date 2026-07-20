// Shared configuration for the vision "describer" - the small vision model that
// captions uploaded images when the user's main model is text-only. Both the
// main chat path (app/api/chat/work.ts) and the framing preprocessors
// (app/lib/framing/attachments.ts) caption images, so the prompt presets, the
// detail level, and the model-resolution rule live here so they stay in sync
// and the user's Preferences drive every path the same way.

import { VISION_DESCRIBER_MODEL } from "@/app/models";

/** How much detail the image describer returns. Surfaced in Preferences. */
export type DescribeDetail = "concise" | "standard" | "detailed";

export const DEFAULT_DESCRIBE_DETAIL: DescribeDetail = "standard";

/** UI metadata for the detail-level picker in Preferences. */
export const DESCRIBE_DETAIL_OPTIONS: ReadonlyArray<{
  id: DescribeDetail;
  label: string;
  hint: string;
}> = [
  {
    id: "concise",
    label: "Concise",
    hint: "A couple of sentences - subject + key text. Fastest.",
  },
  {
    id: "standard",
    label: "Standard",
    hint: "Transcribes visible text, then describes the visuals.",
  },
  {
    id: "detailed",
    label: "Detailed",
    hint: "Exhaustive transcription + every visual element. Slowest.",
  },
];

const DESCRIBE_PROMPTS: Record<DescribeDetail, string> = {
  concise:
    "Briefly describe this image in 2-3 sentences for a text-only model. Lead with the main subject, then the most important visible text (titles, prices, labels). Keep it short - a downstream model just needs the gist.",
  standard:
    "Describe this image thoroughly so a text-only model can reason about it. Transcribe ALL visible text verbatim - product names, titles, prices, specs, ratings, labels, buttons, captions, fine print. Then describe the visual content: subject, layout, objects, people, colors. For screenshots of product pages, listings, or documents, the exact text is more important than visual description. Be exhaustive with text; a downstream model will use your description to answer questions about this image.",
  detailed:
    "Describe this image exhaustively so a text-only model can fully reason about it. First transcribe ALL visible text verbatim, preserving structure - headings, lists, tables, button labels, captions, and fine print. Then describe every visual element: subject, overall layout, spatial arrangement, objects, people, colors, and styling. For any charts or diagrams, report the axes, labels, values, and trends. Call out anything ambiguous or hard to read. Be as complete as possible; a downstream model will rely entirely on your description to answer questions about this image.",
};

/** The describer prompt for a given detail level (defaults to "standard"). */
export function describePromptFor(detail?: DescribeDetail | null): string {
  return DESCRIBE_PROMPTS[detail ?? DEFAULT_DESCRIBE_DETAIL] ?? DESCRIBE_PROMPTS[DEFAULT_DESCRIBE_DETAIL];
}

/** Narrow an arbitrary value to a DescribeDetail, or undefined. */
export function asDescribeDetail(value: unknown): DescribeDetail | undefined {
  return value === "concise" || value === "standard" || value === "detailed"
    ? value
    : undefined;
}

/**
 * Resolve which vision model captions images. Order of precedence:
 *  1. The user's configured describer model from Preferences (`configured`).
 *  2. A RunPod-only deployment override (RUNPOD_VISION_DESCRIBER_MODEL) when the
 *     main model routes to RunPod and the user didn't pick one.
 *  3. The built-in default (VISION_DESCRIBER_MODEL).
 */
export function resolveDescriberModel(opts: {
  configured?: string | null;
  runpodOverride?: string | null;
}): string {
  const configured = opts.configured?.trim();
  if (configured) return configured;
  const runpod = opts.runpodOverride?.trim();
  if (runpod) return runpod;
  return VISION_DESCRIBER_MODEL;
}
