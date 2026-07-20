"use client";

import { cn } from "@/lib/utils";
import { useShowTitleLogo } from "@/app/lib/title-logo-pref";

/**
 * The Lasagna "L" mark shown inline before a panel title ("🅛 Chats").
 * Renders inside an <H1>, sized relative to the heading (0.9em) so it scales
 * with the title and stays glued to the text regardless of the header layout.
 * Returns null when the per-device preference is off (Preferences → Appearance).
 * Decorative — the visible title text already names the surface.
 */
export function TitleLogo({ className }: { className?: string }) {
  const show = useShowTitleLogo();
  if (!show) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny em-sized inline mark; next/image can't size in em
    <img
      src="/logo-mark.png"
      alt=""
      aria-hidden
      draggable={false}
      className={cn(
        "mr-2 inline-block h-[0.9em] w-auto shrink-0 select-none align-[-0.12em]",
        className
      )}
    />
  );
}
