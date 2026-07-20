"use client";

import { useCallback, useEffect, useMemo } from "react";
import { ChevronDown, Plus, Replace, Users, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CATALOG,
  DEFAULT_ENABLED_MODELS,
  defaultModelMeta,
  type CloudModel,
} from "@/app/models";
import { RUNPOD_PREFIX } from "@/app/lib/llm/provider";
import { useAvailableModels } from "@/app/lib/use-available-models";
import {
  COUNCIL_PERSONAS,
  COUNCIL_SITUATIONS,
  CURRENT_COUNCIL_SEED_VERSION,
  DEFAULT_COUNCIL_SITUATION_ID,
  MAX_COUNCIL_DEBATE_ROUNDS,
  MAX_COUNCIL_MEMBERS,
  getDefaultMembers,
  getSituation,
  type CouncilPersona,
} from "@/app/lib/council/situations";
import type { CouncilMember, Settings } from "@/app/db";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onChange: (next: Settings) => void;
};

function newMemberId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedMembersFor(situationId: string, model: string): CouncilMember[] {
  const sit = getSituation(situationId);
  return getDefaultMembers(sit).map((m) => ({
    ...m,
    id: newMemberId(),
    model,
  }));
}

function pickFallbackModel(visible: CloudModel[]): string {
  if (visible.length > 0) return visible[0].id;
  if (CATALOG.length > 0) return CATALOG[0].id;
  return "gpt-oss:120b";
}

/** Resolve the single model every seeded / freshly-added member should use.
 *  Council debates are meant to be fair across perspectives, so seeding never
 *  hands different personas different LLMs — that would let the strongest
 *  model out-argue weaker ones regardless of the merits. Prefers the chat's
 *  current model so the council follows whatever the user picked in the
 *  composer, then the first visible model. */
function pickMemberModel(settings: Settings, visible: CloudModel[]): string {
  if (
    settings.defaultModel &&
    visible.some((v) => v.id === settings.defaultModel)
  ) {
    return settings.defaultModel;
  }
  return pickFallbackModel(visible);
}

export function CouncilSettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
}: Props) {
  const { models } = useAvailableModels(settings.runpodEndpointId);

  // Models the user has actually enabled — same logic as `useVisibleModels`
  // in chat.tsx, kept inline so this dialog doesn't need to reach into the
  // chat module. The activeModel coercion is unnecessary here (the council
  // dialog shows ALL enabled models for picking).
  const visible = useMemo<CloudModel[]>(() => {
    const base = models.length > 0 ? models : CATALOG;
    const seen = new Set(base.map((m) => m.id));
    const source: CloudModel[] = [...base];
    for (const id of settings.customModels ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      source.push(defaultModelMeta(id));
    }
    const enabledIds = settings.enabledModels ?? DEFAULT_ENABLED_MODELS;
    const subset = source.filter((m) => enabledIds.includes(m.id));
    let v = subset.length === 0 ? source : subset;
    if (settings.runpodEndpointId?.trim()) {
      const visibleIds = new Set(v.map((m) => m.id));
      const extras = source.filter(
        (m) => m.id.startsWith(RUNPOD_PREFIX) && !visibleIds.has(m.id)
      );
      if (extras.length > 0) v = [...v, ...extras];
    }
    return v;
  }, [
    models,
    settings.customModels,
    settings.enabledModels,
    settings.runpodEndpointId,
  ]);

  const situationId = settings.councilSituationId ?? DEFAULT_COUNCIL_SITUATION_ID;
  const situation = getSituation(situationId);
  const members = settings.councilMembers ?? [];
  const debateRounds = (settings.councilDebateRounds ?? 1) as 0 | 1 | 2;

  // First-open seeding: when the user opens this dialog and has never set a
  // council before, seed from the default situation so they see real members
  // they can edit instead of an empty list.
  const ensureSeeded = useCallback(() => {
    if (settings.councilMembers !== undefined) return;
    const model = pickMemberModel(settings, visible);
    onChange({
      ...settings,
      councilSituationId: situationId,
      councilMembers: seedMembersFor(situationId, model),
      councilDebateRounds: debateRounds,
      councilSeedVersion: CURRENT_COUNCIL_SEED_VERSION,
    });
  }, [settings, situationId, debateRounds, visible, onChange]);

  // Run the seeding on first open after Settings has hydrated. Effect (not
  // render) so we don't trigger setState during render.
  useEffect(() => {
    if (open) ensureSeeded();
  }, [open, ensureSeeded]);

  const updateSituation = (id: string) => {
    // Switching situations swaps the framing hint but does NOT reset the
    // member roster automatically — the user might have customised it. The
    // "Reset members" button is the explicit gesture for that.
    onChange({ ...settings, councilSituationId: id });
  };

  const resetMembers = () => {
    const model = pickMemberModel(settings, visible);
    onChange({
      ...settings,
      councilMembers: seedMembersFor(situationId, model),
      councilSeedVersion: CURRENT_COUNCIL_SEED_VERSION,
    });
  };

  const addBlankMember = () => {
    if (members.length >= MAX_COUNCIL_MEMBERS) return;
    const next: CouncilMember = {
      id: newMemberId(),
      name: "New member",
      perspective:
        "Describe this perspective: who they are, what they care about, how they argue.",
      model: pickMemberModel(settings, visible),
    };
    onChange({ ...settings, councilMembers: [...members, next] });
  };

  const addFromPersona = (persona: CouncilPersona) => {
    if (members.length >= MAX_COUNCIL_MEMBERS) return;
    const next: CouncilMember = {
      id: newMemberId(),
      name: persona.name,
      perspective: persona.perspective,
      model: pickMemberModel(settings, visible),
    };
    onChange({ ...settings, councilMembers: [...members, next] });
  };

  // Swap preserves the existing member's model so the user keeps whatever
  // they (or migration) put there — and so the roster stays consistent if
  // every slot is already on the same model.
  const swapMemberPersona = (memberId: string, persona: CouncilPersona) => {
    if (!members.some((m) => m.id === memberId)) return;
    updateMember(memberId, {
      name: persona.name,
      perspective: persona.perspective,
    });
  };

  const removeMember = (id: string) => {
    onChange({
      ...settings,
      councilMembers: members.filter((m) => m.id !== id),
    });
  };

  const updateMember = (id: string, patch: Partial<CouncilMember>) => {
    onChange({
      ...settings,
      councilMembers: members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="sheet"
        className="max-h-[90svh] overflow-y-auto overscroll-contain sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Council
          </DialogTitle>
          <DialogDescription>
            Multi-perspective debate. When the council toggle is on, your next
            send is read by a small framer first to ground the debate, then
            each member produces a position, optionally debates, and a
            synthesizer pulls everything into one recommendation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Situation */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Situation</span>
            <select
              className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none transition hover:bg-muted focus:border-foreground/30"
              value={situationId}
              onChange={(e) => updateSituation(e.target.value)}
            >
              {COUNCIL_SITUATIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {situation.description}
            </span>
          </div>

          {/* Members */}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Members</span>
                <span className="text-xs text-muted-foreground">
                  {members.length} of {MAX_COUNCIL_MEMBERS} · each runs in
                  parallel per round
                </span>
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={resetMembers}
                  title={`Replace with the default roster for "${situation.label}".`}
                >
                  Reset
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={members.length >= MAX_COUNCIL_MEMBERS}
                        title="Add from the council pool, or a blank slot."
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add
                        <ChevronDown className="h-3 w-3 opacity-60" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-[280px]">
                    {COUNCIL_PERSONAS.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => addFromPersona(p)}
                        className="flex flex-col items-start gap-0.5"
                      >
                        <span className="text-sm font-medium">{p.name}</span>
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {p.perspective}
                        </span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem
                      onClick={addBlankMember}
                      className="border-t border-border"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="text-sm">Blank member</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {members.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No members yet. Click <span className="font-medium">Reset</span>{" "}
                to load the preset for this situation, or{" "}
                <span className="font-medium">Add</span> to build one from
                scratch.
              </div>
            )}

            <ul className="flex flex-col gap-2">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={m.name}
                      onChange={(e) =>
                        updateMember(m.id, { name: e.target.value })
                      }
                      placeholder="Name (e.g. Mentor)"
                      aria-label="Member name"
                      className="flex-1"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Swap persona for ${m.name}`}
                        title="Swap with another persona from the council pool."
                        className="tap rounded p-1 text-muted-foreground hover:text-foreground"
                      >
                        <Replace className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[280px]">
                        {COUNCIL_PERSONAS.map((p) => (
                          <DropdownMenuItem
                            key={p.id}
                            onClick={() => swapMemberPersona(m.id, p)}
                            className="flex flex-col items-start gap-0.5"
                          >
                            <span className="text-sm font-medium">
                              {p.name}
                            </span>
                            <span className="line-clamp-2 text-xs text-muted-foreground">
                              {p.perspective}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      type="button"
                      onClick={() => removeMember(m.id)}
                      aria-label={`Remove ${m.name}`}
                      className="tap rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <Textarea
                    value={m.perspective}
                    onChange={(e) =>
                      updateMember(m.id, { perspective: e.target.value })
                    }
                    placeholder="Perspective — who they are, what they care about, how they argue."
                    aria-label="Member perspective"
                    className="min-h-[72px] text-xs"
                  />
                  <select
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none transition hover:bg-muted focus:border-foreground/30"
                    value={m.model}
                    onChange={(e) =>
                      updateMember(m.id, { model: e.target.value })
                    }
                    aria-label="Member model"
                  >
                    {/* If the saved model is no longer in the visible list,
                        surface it as an extra option so the user can see what
                        it's set to without it silently flipping. */}
                    {!visible.some((v) => v.id === m.model) && (
                      <option value={m.model}>{m.model} (not enabled)</option>
                    )}
                    {visible.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} · {v.size}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>

          {/* Debate rounds */}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="text-sm font-medium">Debate rounds</span>
            <span className="text-xs text-muted-foreground">
              How many extra rounds members debate after their initial
              position. Each round adds one parallel call per member.
            </span>
            <div className="flex gap-1.5">
              {([0, 1, 2] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() =>
                    onChange({ ...settings, councilDebateRounds: n })
                  }
                  aria-pressed={debateRounds === n}
                  className={cn(
                    "tap flex-1 rounded-md border px-2 py-1.5 text-xs transition",
                    debateRounds === n
                      ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)] text-[var(--color-accent-2)]"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {n === 0
                    ? "0 · no debate"
                    : n === 1
                      ? "1 · short"
                      : `${n} · max`}
                </button>
              ))}
            </div>
            {debateRounds > MAX_COUNCIL_DEBATE_ROUNDS && (
              <span className="text-xs text-destructive">
                Debate rounds capped at {MAX_COUNCIL_DEBATE_ROUNDS}.
              </span>
            )}
          </div>

          {/* Synthesizer model */}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="text-sm font-medium">Synthesizer</span>
            <span className="text-xs text-muted-foreground">
              The model that pulls every position into one recommendation. Pick{" "}
              <span className="italic">Use chat&rsquo;s current model</span> to
              follow whatever you have selected in the composer.
            </span>
            <select
              className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none transition hover:bg-muted focus:border-foreground/30"
              value={settings.councilSynthesizerModel ?? ""}
              onChange={(e) =>
                onChange({
                  ...settings,
                  councilSynthesizerModel: e.target.value || undefined,
                })
              }
              aria-label="Synthesizer model"
            >
              <option value="">Use chat&rsquo;s current model</option>
              {visible.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.size}
                </option>
              ))}
            </select>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
