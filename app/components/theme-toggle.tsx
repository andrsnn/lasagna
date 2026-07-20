"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export const THEME_STORAGE_KEY = "artifacts:theme";
export type Theme = "light" | "dark";

// Read the actual current theme from the DOM. The boot script in
// app/layout.tsx applies the right class before React hydrates, so this
// avoids a hydration mismatch and is the source of truth.
function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private mode, quota); the class still flips.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  // Start as light to match SSR output; useEffect syncs to the real value
  // immediately on mount without changing markup that React rendered.
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }, []);

  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  const Icon = isDark ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      // suppressHydrationWarning: the icon flips based on the actual DOM
      // theme post-mount, which can differ from SSR's light default.
      suppressHydrationWarning
      className={cn(
        "tap inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-2 py-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {mounted ? (
        <Icon className="h-5 w-5" strokeWidth={2} />
      ) : (
        <Moon className="h-5 w-5" strokeWidth={2} />
      )}
    </button>
  );
}
