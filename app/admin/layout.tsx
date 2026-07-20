"use client";

// Shared chrome for every /admin/* page. Just a slim top nav so jumping
// between admin sections doesn't require URL-typing. Admin pages aren't
// linked from the public bottom-nav (that's intentional — admin is hidden
// behind the URL), so this header is the only cross-link surface.
//
// Keeps the children unwrapped so existing admin pages — which set their
// own `h-full scroll-area max-w-*` containers — keep working untouched.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertOctagon,
  Calendar,
  Cloud,
  Cpu,
  Database,
  KeyRound,
  Mail,
  RefreshCcw,
  Users,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/admin/accounts", label: "Accounts", icon: Users },
  { href: "/admin/account-sync", label: "Sync", icon: RefreshCcw },
  { href: "/admin/redis", label: "Redis", icon: Database },
  { href: "/admin/diagnostics", label: "Diagnostics", icon: Activity },
  { href: "/admin/worker", label: "Worker", icon: Cpu },
  { href: "/admin/schedules", label: "Schedules", icon: Calendar },
  { href: "/admin/errors", label: "Errors", icon: AlertOctagon },
  { href: "/admin/tools", label: "Tools", icon: Wrench },
  { href: "/admin/runpod", label: "RunPod", icon: Cloud },
  { href: "/admin/invites", label: "Invites", icon: Mail },
  { href: "/admin/sessions", label: "Sessions", icon: KeyRound },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <nav className="shrink-0 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-3 py-2">
          {SECTIONS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
