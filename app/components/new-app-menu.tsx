"use client";

// The "New app" launcher: chat-first. The user describes the app they want, the
// AI picks the closest known-good template (via /api/app-intent) and names it,
// then we drop them into the designer chat with their request prefilled so the
// assistant customizes the scaffold from there. A manual template list stays
// available for people who already know the shape they want.
//
// Templates are declared in app/lib/app-templates.ts; their files live in
// app/lib/create.ts.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Newspaper,
  Plus,
  Sparkles,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_TEMPLATES, type AppTemplateId } from "@/app/lib/app-templates";
import { createDesignerAndChat } from "@/app/lib/create";
import { cn } from "@/lib/utils";

const ICONS = { Sparkles, Newspaper, ListChecks, LayoutDashboard, CalendarClock } as const;

export function NewAppMenu({
  triggerClassName,
  label = "New app",
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  triggerClassName?: string;
  label?: string;
  /** Controlled mode: drive the dialog from a parent (e.g. a separate CTA). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in trigger button (used with controlled mode). */
  hideTrigger?: boolean;
}) {
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (o: boolean) => {
    onOpenChange?.(o);
    if (controlledOpen === undefined) setUncontrolledOpen(o);
  };
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Describe → AI picks a template + title → designer chat opens prefilled with
  // the request. Template selection is best-effort; on any hiccup we fall back
  // to the blank scaffold so the user is never blocked.
  async function build() {
    const d = desc.trim();
    if (!d || busy) return;
    setBusy(true);
    setError(null);
    try {
      let templateId: AppTemplateId = "blank";
      let title: string | undefined;
      try {
        const res = await fetch("/api/app-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: d }),
        });
        if (res.ok) {
          const j = (await res.json()) as { templateId?: AppTemplateId; title?: string };
          if (j?.templateId) templateId = j.templateId;
          if (typeof j?.title === "string" && j.title.trim()) title = j.title.trim();
        }
      } catch {
        /* offline / model hiccup — fall back to blank below */
      }
      const { designer } = await createDesignerAndChat(
        templateId,
        title ? { title } : undefined
      );
      // autosend=1 → the designer sends the description immediately so the
      // assistant starts customizing the scaffold without an extra tap.
      router.push(
        `/designer/${designer.id}?prefill=${encodeURIComponent(d)}&autosend=1`
      );
    } catch {
      setBusy(false);
      setError("Couldn't create the app. Try again.");
    }
  }

  async function pick(id: AppTemplateId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { designer } = await createDesignerAndChat(id);
      router.push(`/designer/${designer.id}`);
    } catch {
      setBusy(false);
      setError("Couldn't create the app. Try again.");
    }
  }

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "tap reader-label inline-flex items-center gap-1 hover:text-foreground",
            triggerClassName
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          {label}
        </button>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!busy) setOpen(o);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New app</DialogTitle>
            <DialogDescription>
              Describe what you want - the assistant picks a template and builds it with
              you in chat.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => {
                // Enter (without Shift) or Cmd/Ctrl+Enter submits.
                if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void build();
                }
              }}
              rows={3}
              placeholder="e.g. an app to track my job applications with status and a contact for each"
              disabled={busy}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void build()}
              disabled={busy || !desc.trim()}
              className="tap inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {busy ? "Setting up…" : "Build app"}
            </button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="mt-1">
            <div className="reader-label mb-1.5 text-muted-foreground">
              or start from a template
            </div>
            <div className="grid gap-1">
              {APP_TEMPLATES.map((t) => {
                const Icon = ICONS[t.icon];
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void pick(t.id)}
                    className="tap flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-secondary disabled:opacity-50"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium leading-tight">{t.label}</span>
                      <span className="text-xs text-muted-foreground">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
