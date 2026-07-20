/**
 * Cheap token estimation for budget gating.
 * Heuristic: ~3.6 chars/token across mixed prose+code (tunable).
 * The real number comes back from the API in usage events; we recalibrate from there.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

/** Sum estimated tokens of a sequence of role+content messages. */
export function estimateMessageTokens(
  messages: { role: string; content: string }[]
): number {
  // 4 tokens of overhead per message frame (role + delimiters), conservative.
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/**
 * Flat per-image vision-token cost. Providers differ wildly (Claude ~1.5k for a
 * large image, OpenAI tiles ~85-765); a conservative flat value is enough to
 * trip compaction before overflow. Mirrors PER_IMAGE_TOKENS in chat.tsx.
 */
export const PER_IMAGE_TOKENS = 1200;

/**
 * Token estimate for a live conversation array that ALSO counts `.thinking`
 * and `.images`. The plain `estimateMessageTokens` undercounts the agentic
 * loop badly: reasoning models preserve their `thinking` trace into the
 * conversation every tool round (often the single biggest contributor), and
 * images ride on the user/tool messages - both invisible to a `.content`-only
 * sum. Counting them is what keeps the in-loop compaction budget honest so a
 * long tool chain trips compaction instead of silently overflowing the window.
 *
 * Typed structurally so callers can pass `ollama` `Message[]` straight through
 * without a `{role, content}` projection (that projection is exactly what drops
 * the fields the bug undercounted).
 */
export function estimateConvTokens(
  messages: {
    role: string;
    content?: unknown;
    thinking?: unknown;
    images?: unknown[];
  }[]
): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    const thinking = typeof m.thinking === "string" ? m.thinking : "";
    total += estimateTokens(content) + estimateTokens(thinking) + 4;
    if (Array.isArray(m.images)) total += m.images.length * PER_IMAGE_TOKENS;
  }
  return total;
}
