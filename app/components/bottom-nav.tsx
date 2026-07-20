"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { AppWindow, LayoutGrid, LogOut, MessageSquare, Pin, SlidersHorizontal } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

async function logout(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    // Even if the request fails we still want to bounce to /login — the
    // server-side cookie clear is best-effort; the browser falling back to
    // /login will fail middleware auth and re-render the form anyway.
  }
  window.location.href = "/login";
}

const links = [
  { href: "/chats", label: "Chats", icon: MessageSquare },
  { href: "/notes", label: "Notes", icon: Pin },
  { href: "/", label: "Widgets", icon: LayoutGrid },
  { href: "/designer", label: "Apps", icon: AppWindow },
  { href: "/manage", label: "Manage", icon: SlidersHorizontal },
];

// Global tabs stay visible everywhere except the login/signup screens and
// public share viewers, so the user can jump between sections from any
// depth. Sub-views inside a section (e.g. Chat/Preview/Details on a
// designer) are reached via in-page dropdowns rather than a competing
// bottom tab bar. Public /share/* routes are viewed by recipients who
// aren't signed in to this deployment — they shouldn't see app navigation.
const HIDE_ON_PREFIXES = ["/login", "/signup", "/marketing", "/share"];

export function BottomNav() {
  const pathname = usePathname();
  if (HIDE_ON_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }
  // Voice and therapist modes are full-screen focus UIs; the nav is noise there.
  if (pathname.endsWith("/voice") || pathname.endsWith("/therapist")) {
    return null;
  }
  // Note canvas is a split-pane editor with its own in-page Note/Chat
  // switcher; the global tabs would compete with it and steal vertical
  // space the chat composer needs on mobile.
  if (pathname.endsWith("/canvas")) {
    return null;
  }

  return (
    <nav className="safe-bottom shrink-0 border-t border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-around gap-1 px-2 py-1.5">
        {links.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "tap inline-flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 2} />
              <span className="reader-label text-current">{label}</span>
            </Link>
          );
        })}
        <ThemeToggle className="shrink-0" />
        <button
          type="button"
          onClick={() => void logout()}
          aria-label="Sign out"
          title="Sign out"
          className="tap inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogOut className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </nav>
  );
}
