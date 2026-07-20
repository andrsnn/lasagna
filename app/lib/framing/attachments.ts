// Shared attachment preprocessor for the framing endpoints. The framers
// (council + research) flatten chat turns into a text transcript before
// asking the LLM for scoping questions, so any images attached to a turn
// are invisible to them. Without describing the image first, the framer
// asks scoping questions whose answers are already visible on the image
// (e.g. "what product are you buying?" when the user attached a vendor
// estimate that names the product).
//
// This module mirrors the vision-describer path from app/api/chat/work.ts:
// run each image through VISION_DESCRIBER_MODEL (or the RunPod override) and
// inline the resulting caption into the message's `content` so it flows
// through renderChatTranscript naturally. PDFs get their extracted text
// inlined the same way work.ts inlines them on the main chat path.
//
// We always describe (never pass raw image bytes), because the framer's
// wrapping user message is a text transcript — attaching base64 frames to
// the wrapper would not associate them with the right turn, and the framer
// only needs the image's content to make scoping decisions, not pixel-level
// fidelity.

import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { providerFor } from "@/app/lib/llm/provider";
import { withDeadline } from "@/app/lib/with-deadline";
import {
  describePromptFor,
  resolveDescriberModel,
  type DescribeDetail,
} from "@/app/lib/describe-image";
import {
  captionCacheKey,
  getCachedCaption,
  setCachedCaption,
} from "@/app/lib/stream-store";
import type { FramerAction } from "@/app/db";

// Per-image describe cap. The framer's overall budget is bounded from entry, so
// a wedged vision turn (the SDK has no AbortSignal) that ran unbounded would
// leave the tool loop with no time to produce scoping questions. On timeout the
// caller surfaces the failure in the framing card and continues without the
// caption rather than hanging the whole producer.
const DESCRIBE_IMAGE_TIMEOUT_MS = 30_000;

export type FramerIncomingImage = {
  id?: string;
  dataUrl: string;
  mime?: string;
  name?: string;
};

export type FramerIncomingPdf = {
  id?: string;
  name: string;
  pageCount: number;
  text: string;
  truncated?: boolean;
};

export type FramerIncomingCsv = {
  id?: string;
  name: string;
  rowCount: number;
  columnCount: number;
  text: string;
  truncated?: boolean;
};

export type FramerIncomingMsg = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: FramerIncomingImage[];
  pdfs?: FramerIncomingPdf[];
  csvs?: FramerIncomingCsv[];
};

export type FramerPreprocessedMsg = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type FramerPreprocessResult = {
  messages: FramerPreprocessedMsg[];
  /** Actions performed before the framer ran — surfaced in the framing
   *  card so the user can see describe_image / attach_pdf actually fired
   *  on their attachments (otherwise the card just shows scoping
   *  questions with no hint that the image was read). */
  actions: FramerAction[];
};

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Resolve the describer model for a framing run: the user's configured choice
 *  wins, else a RunPod-only deployment override when the framer routes to
 *  RunPod, else the built-in default. */
function describerModelFor(framerModel: string, configured?: string): string {
  return resolveDescriberModel({
    configured,
    runpodOverride:
      providerFor(framerModel) === "runpod"
        ? process.env.RUNPOD_VISION_DESCRIBER_MODEL
        : undefined,
  });
}

/** Describe a single image. Returns the caption + an error string on
 *  failure (so the caller can surface the failure in the framing card
 *  rather than silently skipping it). */
async function describeImage(
  describerModel: string,
  runpodEndpointId: string | undefined,
  img: FramerIncomingImage,
  detail: DescribeDetail | undefined
): Promise<{ caption: string; error?: string }> {
  const base64 = dataUrlToBase64(img.dataUrl);
  // Reuse a cached caption for the same image bytes + model + detail. The
  // framer re-describes the same attachments on every re-frame otherwise, and
  // the describer call costs tens of seconds.
  const cacheKey = captionCacheKey(base64, describerModel, detail);
  const cached = await getCachedCaption(cacheKey);
  if (cached != null) return { caption: cached };
  const describer = chatClientFor(describerModel, { runpodEndpointId });
  try {
    const resp = await withRetry(describerModel, () =>
      withDeadline(
        () =>
          describer.chat({
            model: describerModel,
            stream: false,
            think: false,
            messages: [
              {
                role: "user",
                content: describePromptFor(detail),
                images: [base64],
              },
            ],
          }),
        Date.now() + DESCRIBE_IMAGE_TIMEOUT_MS,
        "Image description",
        DESCRIBE_IMAGE_TIMEOUT_MS
      )
    );
    const caption = (resp.message?.content ?? "").trim();
    if (caption) void setCachedCaption(cacheKey, caption);
    return { caption };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[framer] describe_image failed for ${img.name ?? "image"}: ${message}`
    );
    return { caption: "", error: message };
  }
}

/**
 * Inline image captions and PDF text into each message's content so the
 * framer transcript carries the attachment context. Returns plain
 * `{role, content}` messages safe to feed renderChatTranscript.
 *
 * Images are described in parallel within a message to keep the framer's
 * pre-LLM latency reasonable (the typical case is 1–2 images on the last
 * user turn).
 */
export async function preprocessFramerAttachments(
  messages: FramerIncomingMsg[],
  opts: {
    framerModel: string;
    runpodEndpointId?: string;
    /** User's configured describer model (Preferences). Empty ⇒ default. */
    describerModel?: string;
    /** User's configured describer detail level (Preferences). */
    describeDetail?: DescribeDetail;
  }
): Promise<FramerPreprocessResult> {
  const describerModel = describerModelFor(opts.framerModel, opts.describerModel);
  const describeDetail = opts.describeDetail;

  const out: FramerPreprocessedMsg[] = [];
  const actions: FramerAction[] = [];
  for (const m of messages) {
    const validImages = (m.images ?? []).filter(
      (img): img is FramerIncomingImage =>
        !!img && typeof img.dataUrl === "string" && img.dataUrl.length > 0
    );
    const validPdfs = (m.pdfs ?? []).filter(
      (p): p is FramerIncomingPdf =>
        !!p && typeof p.text === "string" && p.text.length > 0
    );
    const validCsvs = (m.csvs ?? []).filter(
      (c): c is FramerIncomingCsv =>
        !!c && typeof c.text === "string" && c.text.length > 0
    );

    if (validImages.length === 0 && validPdfs.length === 0 && validCsvs.length === 0) {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const captions =
      validImages.length > 0
        ? await Promise.all(
            validImages.map(async (img, k) => {
              const { caption, error } = await describeImage(
                describerModel,
                opts.runpodEndpointId,
                img,
                describeDetail
              );
              actions.push({
                kind: "describe_image",
                index: k + 1,
                name: img.name,
                describer: describerModel,
                summary: caption
                  ? caption.slice(0, 200) + (caption.length > 200 ? "…" : "")
                  : undefined,
                error,
              });
              const label = img.name ? ` — ${img.name}` : "";
              const body = caption
                ? caption
                : error
                  ? `(describer failed: ${error})`
                  : "(describer returned an empty caption)";
              return `[Image ${k + 1}${label}, described by ${describerModel}]: ${body}`;
            })
          )
        : [];

    const pdfBlocks = validPdfs.map((pdf, k) => {
      actions.push({
        kind: "attach_pdf",
        index: k + 1,
        name: pdf.name,
        pageCount: pdf.pageCount,
        truncated: pdf.truncated,
      });
      const pages = pdf.pageCount === 1 ? "1 page" : `${pdf.pageCount} pages`;
      const header = `[PDF ${k + 1} — ${pdf.name}, ${pages}${
        pdf.truncated ? ", truncated" : ""
      }]`;
      return `${header}\n${pdf.text}`;
    });

    const csvBlocks = validCsvs.map((csv) => {
      const rows = csv.rowCount === 1 ? "1 row" : `${csv.rowCount} rows`;
      const cols = csv.columnCount === 1 ? "1 column" : `${csv.columnCount} columns`;
      const header = `[CSV — ${csv.name}, ${rows}, ${cols}${
        csv.truncated ? ", truncated" : ""
      }]`;
      return `${header}\n${csv.text}`;
    });

    const head = m.content?.trim() ?? "";
    const parts = [head, ...captions, ...pdfBlocks, ...csvBlocks].filter((s) => s.length > 0);
    out.push({ role: m.role, content: parts.join("\n\n") });
  }
  return { messages: out, actions };
}
