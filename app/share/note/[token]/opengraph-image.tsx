// Dynamic OG card for a shared pinned note.
//
// iMessage / Slack / Discord / Twitter / Facebook fetch this URL when they
// unfurl /share/note/[token]. Returning a real image (not just og:title +
// og:description) triggers the "expanded preview" treatment in most clients.
// We render the note's title + summary inside a branded card via next/og.

import { ImageResponse } from "next/og";
import {
  NOTE_SHARE_TOKEN_REGEX,
  getNoteShare,
  isNoteShareStoreConfigured,
} from "@/app/lib/note-share-store";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Shared note";

export default async function Image({
  params,
}: {
  params: { token: string } | Promise<{ token: string }>;
}) {
  const resolved = await Promise.resolve(params);
  const { token } = resolved;
  const payload =
    NOTE_SHARE_TOKEN_REGEX.test(token) && isNoteShareStoreConfigured()
      ? await getNoteShare(token).catch(() => null)
      : null;

  const title = payload?.title || "Shared note";
  const summary =
    payload?.summary || "A note pinned from Lasagna.";
  const kindLabel =
    payload?.body.kind === "html"
      ? "Shared HTML artifact"
      : payload?.body.kind === "snapshot"
        ? "Shared chat copy"
        : "Shared note";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background:
            "linear-gradient(135deg, #f4efe6 0%, #ead8b8 60%, #d9bfa0 100%)",
          color: "#1f1b16",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "#1f1b16",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#f4efe6",
              fontWeight: 700,
              fontSize: 22,
            }}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f4efe6"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 3.1V7a4 4 0 0 0 8 0V3.1" />
              <path d="m9 15-1-1" />
              <path d="m15 15 1-1" />
              <path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z" />
              <path d="m8 19-2 3" />
              <path d="m16 19 2 3" />
            </svg>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5 }}>
            Lasagna
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -1.5,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 28,
              lineHeight: 1.35,
              color: "#5a4f3d",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {summary}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 22,
            color: "#7a6a52",
          }}
        >
          <div>{kindLabel}</div>
          <div>Tap to read</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
