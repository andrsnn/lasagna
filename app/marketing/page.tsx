import Link from "next/link";
import {
  AlarmClock,
  ArrowRight,
  Check,
  Code,
  Cpu,
  HardDrive,
  LayoutGrid,
  Lock,
  MessagesSquare,
  Newspaper,
  Pin,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  TrainFront,
  Users,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1, H2 } from "@/app/components/serif-heading";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Lasagna - chat it, canvas it, keep it as a widget.",
  description:
    "Every artifact starts as a chat, becomes a canvas you can iterate on, and lives on as a widget or a shareable link. Yours alone, on open-weight models.",
};

// Gradient colors lifted from app/lib/visuals so the bubble avatars match
// the real app's look. Inlined as plain strings (no JS) since the marketing
// page is a static server component with no app data.
const GRADIENTS = {
  rose: "linear-gradient(135deg, #ff8a93, #c84b9a)",
  teal: "linear-gradient(135deg, #4cd1d9, #2d7a8c)",
  amber: "linear-gradient(135deg, #f6b061, #d96d2b)",
  violet: "linear-gradient(135deg, #9b7dff, #5a3fd8)",
  blue: "linear-gradient(135deg, #6cb6ff, #4a6cd6)",
  pink: "linear-gradient(135deg, #ffa3c1, #d96aa6)",
};

export default function MarketingPage() {
  return (
    <div className="scroll-area safe-x h-full">
      <SiteHeader />
      <Hero />
      <FeatureSection
        id="the-loop"
        eyebrow="01 · CHAT"
        eyebrowIcon={<MessagesSquare className="h-3.5 w-3.5" />}
        title="Start with a chat. Turn on Council when it matters."
        body="Describe what you want and the model builds it. For the harder calls — a job offer, a training plan, a treatment decision — switch on Council. Personas debate from different lenses, then synthesize one recommendation."
        mock={<CouncilChatMock />}
      />
      <FeatureSection
        eyebrow="02 · CANVAS"
        eyebrowIcon={<Pin className="h-3.5 w-3.5" />}
        title="Keep it as a canvas you can iterate on."
        body="Pin what's worth keeping. Edit side-by-side with the model — every change is live. When it's ready, share a read-only canvas link."
        reverse
        mock={<PinCanvasShareMock />}
      />
      <FeatureSection
        eyebrow="03 · WIDGET"
        eyebrowIcon={<LayoutGrid className="h-3.5 w-3.5" />}
        title="Promote it to a widget that refreshes itself."
        body="A live tile on your home screen. Set a refresh schedule and the canvas keeps itself up to date — PR tracker, commute, flight status, whatever you actually check."
        mock={<AppsAndWidgetsMock />}
      />
      <Foundation />
      <ClosingCTA />
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Site chrome                                                                */
/* -------------------------------------------------------------------------- */

function SiteHeader() {
  return (
    <header className="safe-top safe-x sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link
          href="/marketing"
          className="inline-flex items-center gap-1.5 font-[family-name:var(--font-display)] text-xl tracking-tight"
        >
          <TrainFront className="h-5 w-5 text-primary" />
          Lasagna
        </Link>
        <Link
          href="/login"
          className="text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="safe-x">
      <div className="mx-auto w-full max-w-6xl px-4 pt-12 pb-10 sm:px-6 sm:pt-20 sm:pb-16">
        <p className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Chat · Canvas · Widget
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl leading-[1.05] tracking-tight sm:text-6xl">
          Chat it. Canvas it.
          <br />
          <span className="text-primary">Keep it as a widget.</span>
        </h1>
        <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
          Every artifact starts as a chat, becomes a canvas you can iterate on,
          and lives on as a widget on your home screen — or a read-only link
          you share.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85"
          >
            Try it now
            <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href="#the-loop"
            className="inline-flex h-11 items-center rounded-xl border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
          >
            See the loop
          </a>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Feature section scaffold                                                   */
/* -------------------------------------------------------------------------- */

function FeatureSection({
  id,
  eyebrow,
  eyebrowIcon,
  title,
  body,
  mock,
  reverse,
}: {
  id?: string;
  eyebrow: string;
  eyebrowIcon: React.ReactNode;
  title: string;
  body: string;
  mock: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <section id={id} className="safe-x border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div
          className={cn(
            "grid items-center gap-10 lg:grid-cols-2 lg:gap-16",
            reverse && "lg:[&>div:first-child]:order-2"
          )}
        >
          <div className="max-w-lg">
            <p className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold tracking-[0.18em] text-primary">
              {eyebrowIcon}
              {eyebrow}
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-3xl leading-[1.1] tracking-tight sm:text-4xl">
              {title}
            </h2>
            <p className="mt-4 text-base text-muted-foreground sm:text-lg">
              {body}
            </p>
          </div>
          <div>{mock}</div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* CHAT mock — single chat with Council framing, debate, synthesis            */
/* -------------------------------------------------------------------------- */

function CouncilChatMock() {
  const personas = [
    {
      name: "Coach",
      stance: "On pace, but mileage is light. Add one 18-miler.",
      gradient: GRADIENTS.blue,
    },
    {
      name: "Skeptic",
      stance: "Sub-3 needs 6:50/mi. Recent 10K says 7:02.",
      gradient: GRADIENTS.teal,
    },
    {
      name: "Data Nerd",
      stance: "VO₂ trend +4% in 8wk — finish line within 1.5%.",
      gradient: GRADIENTS.violet,
    },
  ];

  return (
    <MockFrame label="Chat">
      <MockHeader
        title="Am I on track for sub-3?"
        subtitle="Marathon, fall — 14 weeks out."
        right={
          <span className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground">
            <Users className="h-3 w-3" />
            Council · 3
          </span>
        }
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        {/* User message bubble */}
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-[var(--shadow-1)]">
            Am I on track for a sub-3 marathon this fall?
          </div>
        </div>

        {/* Persona debate cards */}
        <div className="space-y-2">
          {personas.map((p) => (
            <PaperCard key={p.name} className="flex items-start gap-3 p-3">
              <div
                className="h-8 w-8 shrink-0 rounded-lg"
                style={{ background: p.gradient }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">{p.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {p.stance}
                </p>
              </div>
            </PaperCard>
          ))}
        </div>

        {/* Synthesis card */}
        <PaperCard tone="raised" className="p-3.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-primary">
            <Sparkles className="h-3 w-3" />
            SYNTHESIS
          </div>
          <p className="mt-1.5 text-sm leading-snug">
            Likely yes, with one tweak: hold mileage at 55, drop 10K race-pace
            to 6:55 in week 9. The Data Nerd's trend wins if you nail the
            18-miler at goal pace.
          </p>
        </PaperCard>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* KEEP & REFINE mock — pin, canvas edit, iterations, share                   */
/* -------------------------------------------------------------------------- */

function PinCanvasShareMock() {
  const lines = [
    "# Date ideas",
    "## Fort Greene",
    "",
    "- Olea — wine bar, 6m walk",
    "- BAM — film + bar, 9m walk",
    "- Walter's — vinyl bar, late",
  ];
  const activeLine = 5;

  return (
    <MockFrame label="Canvas">
      <MockHeader
        title="Date ideas — Fort Greene"
        subtitle="Canvas — edit live, chat to refine."
        right={
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground">
            <Share2 className="h-3 w-3" />
            Share · 6d left
          </span>
        }
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        <PaperCard className="overflow-hidden">
          {/* Editor toolbar */}
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5">
            <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              CANVAS
            </span>
            <span className="ml-auto rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
              v3
            </span>
          </div>
          {/* Script editor surface */}
          <div className="font-mono text-[11px] leading-[1.55]">
            {lines.map((line, i) => {
              const isActive = i === activeLine;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex gap-3 px-3",
                    isActive && "bg-primary/[0.06]"
                  )}
                >
                  <span className="select-none text-right text-muted-foreground/60 tabular-nums w-4">
                    {i + 1}
                  </span>
                  <span className="flex-1 whitespace-pre text-foreground/85">
                    {line || " "}
                    {isActive && (
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 bg-primary align-middle animate-pulse"
                      />
                    )}
                  </span>
                </div>
              );
            })}
            <div className="h-2" />
          </div>
        </PaperCard>

        {/* Chat bar: iterate by chatting */}
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-[var(--shadow-1)]">
          <p className="flex-1 truncate text-[11px] text-muted-foreground">
            Make Walter's a vinyl bar
          </p>
          <button
            type="button"
            aria-label="Send"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* APPS & WIDGETS mock — designer, widgets grid, cron                         */
/* -------------------------------------------------------------------------- */

function AppsAndWidgetsMock() {
  return (
    <MockFrame label="Apps & Widgets">
      <MockHeader
        title="PR Tracker"
        subtitle="App · live on your home as a widget."
        right={
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground">
            <AlarmClock className="h-3 w-3" />
            Hourly
          </span>
        }
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        {/* Featured dark hero tile */}
        <div className="rounded-2xl bg-[#1c1916] p-4 text-[#f1ece2] shadow-[var(--shadow-1)] dark:bg-[#0f0d0b]">
          <p className="text-[10px] font-semibold tracking-[0.18em] text-[#a89e89]">
            PR TRACKER
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-3xl tracking-tight">
            10K · 39:14
          </p>
          <p className="mt-0.5 text-sm text-[#c4baa6]">
            7s off PR · <span className="text-[#e07358]">go Sun</span>
          </p>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#a89e89]">
            <span>cool · 8 mph SW</span>
            <span>flat course</span>
          </div>
        </div>

        {/* 2x2 widget grid */}
        <div className="grid grid-cols-2 gap-3">
          <PaperCard className="p-3.5">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              COMMUTE
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-2xl tracking-tight">
              Bike? <span className="text-primary">Yes</span>
            </p>
            <p className="text-xs text-muted-foreground">64° clear · AQI 38</p>
          </PaperCard>

          <PaperCard className="p-3.5">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              MAPLE HILL
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-2xl tracking-tight">
              6 mph
            </p>
            <p className="text-xs text-muted-foreground">SW · disc-friendly</p>
          </PaperCard>

          <PaperCard className="p-3.5">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              FLIGHT
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-2xl tracking-tight">
              BOS → LIS
            </p>
            <p className="text-xs text-muted-foreground">2h 14m · Gate B23</p>
          </PaperCard>

          <PaperCard className="p-3.5">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              CONCERT
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-lg leading-tight">
              Big Thief
            </p>
            <p className="text-xs text-muted-foreground">Bklyn Steel · Jun 14</p>
          </PaperCard>
        </div>

        {/* Designer footer row */}
        <PaperCard className="flex items-center gap-2 px-3 py-2.5">
          <Code className="h-4 w-4 text-primary" />
          <p className="text-xs font-medium">Designer</p>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            v7
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            chat to edit
          </span>
        </PaperCard>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* PRIVACY mock — local-first, encrypted at rest, opt-in sharing              */
/* -------------------------------------------------------------------------- */

function PrivacyMock() {
  const rows = [
    {
      icon: <HardDrive className="h-4 w-4 text-primary" />,
      title: "IndexedDB on this device",
      body: "Chats, notes, apps — all local.",
    },
    {
      icon: <Share2 className="h-4 w-4 text-primary" />,
      title: "Sharing requires a tap",
      body: "Nothing leaves until you say so.",
    },
    {
      icon: <RefreshCw className="h-4 w-4 text-primary" />,
      title: "Sync to your devices is opt-in",
      body: "Push to iPad, laptop — on your schedule.",
    },
  ];

  return (
    <MockFrame label="Privacy">
      <MockHeader
        title="Your device"
        subtitle="Local-first storage. Yours alone."
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        {/* Lock hero */}
        <PaperCard
          tone="raised"
          className="flex flex-col items-center gap-2 p-6 text-center"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Lock className="h-7 w-7 text-primary" />
          </div>
          <p className="mt-1 font-[family-name:var(--font-display)] text-xl tracking-tight">
            Encrypted at rest
          </p>
          <p className="text-[11px] text-muted-foreground">
            On your phone, not someone else's cloud.
          </p>
        </PaperCard>

        {/* Checklist */}
        <PaperCard className="divide-y divide-border/60">
          {rows.map((row) => (
            <div key={row.title} className="flex items-start gap-3 px-3.5 py-3">
              <div className="mt-0.5">{row.icon}</div>
              <div className="min-w-0">
                <p className="text-xs font-semibold">{row.title}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {row.body}
                </p>
              </div>
            </div>
          ))}
        </PaperCard>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* OPEN MODELS mock — model picker + benchmark callout                        */
/* -------------------------------------------------------------------------- */

function ModelsMock() {
  const models = [
    {
      name: "DeepSeek V4 Pro",
      use: "Frontier reasoning · 1M ctx",
      gradient: GRADIENTS.violet,
      selected: true,
    },
    {
      name: "Kimi K2.6",
      use: "Long-horizon coding",
      gradient: GRADIENTS.teal,
    },
    {
      name: "GPT-OSS 120B",
      use: "General chat · open weights",
      gradient: GRADIENTS.amber,
    },
    {
      name: "Qwen3 Coder Next",
      use: "Coding & agentic dev",
      gradient: GRADIENTS.blue,
    },
  ];

  return (
    <MockFrame label="Models">
      <MockHeader
        title="Model"
        subtitle="Pick per chat — switch any time."
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        <ul className="space-y-2">
          {models.map((m) => (
            <li key={m.name}>
              <PaperCard
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5",
                  m.selected && "border-primary/60 bg-primary/[0.04]"
                )}
              >
                <div
                  className="h-8 w-8 shrink-0 rounded-lg"
                  style={{ background: m.gradient }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {m.use}
                  </p>
                </div>
                {m.selected && (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                )}
              </PaperCard>
            </li>
          ))}
        </ul>

        {/* Benchmark callout */}
        <PaperCard tone="raised" className="p-3.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              LIVECODEBENCH
            </p>
            <span className="text-[10px] text-muted-foreground">
              higher = better
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {[
              { name: "DeepSeek V4 Pro", score: 93.5, width: "94%", primary: true },
              { name: "Kimi K2.6", score: 89.6, width: "90%", primary: true },
              { name: "Claude Opus 4.6", score: 76, width: "76%" },
            ].map((row) => (
              <div key={row.name}>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">{row.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {row.score}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      row.primary ? "bg-primary" : "bg-muted-foreground/50"
                    )}
                    style={{ width: row.width }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[10px] text-muted-foreground">
            Open-weight models lead coding benchmarks at a fraction of the cost.
          </p>
        </PaperCard>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* NO RUG PULLS mock — news cards + contrast checklist                        */
/* -------------------------------------------------------------------------- */

function NoRugPullsMock() {
  const wins = [
    "Open-weight models — inspect them yourself",
    "Local-first — your chats never leave by default",
    "Your backend, your rules — today RunPod, more soon",
  ];

  return (
    <MockFrame label="No rug pulls">
      <MockHeader
        title="What you avoid"
        subtitle="When the rules change under your feet."
      />
      <div className="space-y-3 px-4 pb-4 pt-3">
        <a
          href="https://zed.dev/blog/anthropic-subscription-changes"
          target="_blank"
          rel="noreferrer noopener"
          className="block"
        >
          <PaperCard className="p-3.5 transition-colors hover:bg-muted/30">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              <Newspaper className="h-3 w-3" />
              ZED · BILLING
            </div>
            <p className="mt-1.5 text-sm font-semibold leading-snug">
              Anthropic restructures Claude billing. Agent usage moves to a new
              pool.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Volume discounts cut. Costs up for many. Read more →
            </p>
          </PaperCard>
        </a>

        <a
          href="https://news.bloomberglaw.com/ip-law/openai-must-turn-over-20-million-chatgpt-logs-judge-affirms"
          target="_blank"
          rel="noreferrer noopener"
          className="block"
        >
          <PaperCard className="p-3.5 transition-colors hover:bg-muted/30">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              <Newspaper className="h-3 w-3" />
              BLOOMBERG · PRIVACY
            </div>
            <p className="mt-1.5 text-sm font-semibold leading-snug">
              OpenAI must turn over 20M ChatGPT logs. Court-ordered preservation
              overrides delete.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Chats users thought were ephemeral, kept indefinitely. Read more →
            </p>
          </PaperCard>
        </a>

        <PaperCard tone="raised" className="p-3.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-primary">
            <ShieldCheck className="h-3 w-3" />
            ON LASAGNA
          </div>
          <ul className="mt-2 space-y-1.5">
            {wins.map((line) => (
              <li key={line} className="flex items-start gap-2 text-xs">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </PaperCard>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Mock frame + shared header (mimics the app's sticky tab header)            */
/* -------------------------------------------------------------------------- */

function MockFrame({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  // Width is capped at 380 so the mock reads as a single phone-sized slab even
  // on wide screens — matches how the real app looks on mobile, which is its
  // canonical form.
  return (
    <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-[28px] border border-border bg-background shadow-[var(--shadow-2)]">
      <div aria-hidden className="sr-only">{label}</div>
      {children}
    </div>
  );
}

function MockHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60 bg-background/85 px-4 pt-4 pb-3 backdrop-blur">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <H1 className="text-2xl">{title}</H1>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {subtitle}
          </p>
        </div>
        {right}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Foundation — why you can trust the loop with your stuff                    */
/* -------------------------------------------------------------------------- */

function Foundation() {
  const pillars = [
    {
      eyebrow: "LOCAL-FIRST",
      icon: <Lock className="h-3.5 w-3.5" />,
      title: "Yours alone, on your device.",
      body: "Chats, canvases, widgets — all in IndexedDB on your device. Nothing leaves until you tap Share.",
      mock: <PrivacyMock />,
    },
    {
      eyebrow: "OPEN MODELS",
      icon: <Cpu className="h-3.5 w-3.5" />,
      title: "Open-weight, frontier-grade.",
      body: "Pick the model per chat. Open weights match or beat closed frontier on coding, at a fraction of the cost.",
      mock: <ModelsMock />,
    },
    {
      eyebrow: "NO RUG PULLS",
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      title: "The rules don't change under your feet.",
      body: "Open weights you can inspect, and a backend you control. The contract doesn't get rewritten on you.",
      mock: <NoRugPullsMock />,
    },
  ];

  return (
    <section className="safe-x border-t border-border/60 bg-muted/30">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <p className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold tracking-[0.18em] text-primary">
            <ShieldCheck className="h-3.5 w-3.5" />
            FOUNDATION
          </p>
          <H2 className="text-3xl sm:text-4xl">
            Yours alone. No rug pulls.
          </H2>
          <p className="mt-3 text-base text-muted-foreground sm:text-lg">
            The loop runs on your device, on models you can inspect, on a
            backend you control.
          </p>
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-3 lg:gap-10">
          {pillars.map((p) => (
            <div key={p.eyebrow}>
              <p className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold tracking-[0.18em] text-primary">
                {p.icon}
                {p.eyebrow}
              </p>
              <h3 className="font-[family-name:var(--font-display)] text-2xl leading-tight tracking-tight">
                {p.title}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
              <div className="mt-6">{p.mock}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Closing CTA + footer                                                       */
/* -------------------------------------------------------------------------- */

function ClosingCTA() {
  return (
    <section className="safe-x border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="rounded-3xl border border-border bg-card p-8 text-center shadow-[var(--shadow-2)] sm:p-12">
          <h2 className="font-[family-name:var(--font-display)] text-3xl leading-[1.1] tracking-tight sm:text-5xl">
            Start a chat. Keep a canvas.{" "}
            <span className="text-primary">Run a widget.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted-foreground">
            The whole loop, in minutes — and yours alone.
          </p>
          <div className="mt-7 flex justify-center">
            <Link
              href="/login"
              className="inline-flex h-12 items-center gap-1.5 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Get started
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="safe-bottom safe-x border-t border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:px-6">
        <p>
          <span className="font-[family-name:var(--font-display)] text-sm text-foreground">
            Lasagna
          </span>{" "}
          · chat it, canvas it, keep it as a widget
        </p>
        <Link href="/login" className="hover:text-foreground">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
