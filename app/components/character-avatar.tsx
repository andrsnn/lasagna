"use client";

import type { ReactElement } from "react";
import { gradientFor } from "@/app/lib/visuals";
import { useAvatarStyle, type AvatarStyle } from "@/app/lib/avatar-style";

// Deterministic chat avatars. The exported component picks one of four
// renderers based on the per-device "avatarStyle" preference:
//
//   • ink      — line-drawn creature on a paper card, inked in the theme's
//     foreground with a faint per-id tint wash. The default; matches the
//     reader design language.
//   • friendly — smooth gradient body with a curved emoji-style face
//     (eyes, mouth, occasional accessory). Reads warm and approachable.
//   • kawaii   — same gradient body, but always anime eyes + smile +
//     blush. Every avatar is unambiguously cute; only the palette and a
//     tiny wink-side bit vary per id.
//   • pixel    — 16×16 pixel-art alien creatures on a dark "screen"
//     backdrop. Retro vibe; kept as an opt-in for people who liked it.

function hash(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface CharacterAvatarProps {
  id: string;
  className?: string;
  title?: string;
  /** Override the current style preference — used by the Preferences picker
   *  to render side-by-side previews. */
  style?: AvatarStyle;
}

export function CharacterAvatar({ style: styleOverride, ...rest }: CharacterAvatarProps) {
  const preferred = useAvatarStyle();
  const style = styleOverride ?? preferred;
  if (style === "pixel") return <PixelAvatar {...rest} />;
  if (style === "kawaii") return <KawaiiAvatar {...rest} />;
  if (style === "friendly") return <FriendlyAvatar {...rest} />;
  return <InkAvatar {...rest} />;
}

// ---------------------------------------------------------------------------
// Ink — the reader-vocabulary renderer. A wobbly hand-drawn blob stroked in
// the theme's foreground on a paper card, with the same face grammar as
// Friendly (eyes/mouth/accessory/blush picked from the id hash) but drawn as
// thin line art. The per-id gradient palette survives only as a faint tint
// wash inside the body so siblings stay tellable-apart without breaking the
// muted page.
// ---------------------------------------------------------------------------

function InkAvatar({ id, className, title }: CharacterAvatarProps) {
  const h = hash(id);
  const palette = gradientFor(id);
  const eyes = FRIENDLY_EYES[(h >> 3) % FRIENDLY_EYES.length];
  const mouth = FRIENDLY_MOUTHS[(h >> 7) % FRIENDLY_MOUTHS.length];
  const accessory =
    FRIENDLY_ACCESSORIES[(h >> 11) % FRIENDLY_ACCESSORIES.length];
  const blush = ((h >> 17) & 1) === 1;
  // Slight per-id squash and tilt so the blobs read as drawn, not stamped.
  const rx = 19 + ((h >> 21) % 4);
  const ry = 17 + ((h >> 23) % 4);
  const tilt = ((h >> 25) % 9) - 4;
  const ink = "var(--foreground)";
  const wash = `color-mix(in oklab, ${palette.via} 16%, transparent)`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "avatar"}
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx="17.5"
        fill="var(--card)"
        stroke="var(--border)"
        strokeWidth="1"
      />
      <ellipse
        cx="32"
        cy="36"
        rx={rx}
        ry={ry}
        transform={`rotate(${tilt} 32 36)`}
        fill={wash}
        stroke={ink}
        strokeWidth="1.6"
      />
      <g
        transform="translate(0, 6)"
        stroke={ink}
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        <InkAccessoryShape kind={accessory} ink={ink} />
      </g>
      {blush && (
        <g fill={BLUSH} opacity="0.35">
          <ellipse cx="20" cy="42" rx="3" ry="1.8" />
          <ellipse cx="44" cy="42" rx="3" ry="1.8" />
        </g>
      )}
      <InkEyesShape kind={eyes} ink={ink} />
      <InkMouthShape kind={mouth} ink={ink} />
    </svg>
  );
}

function InkEyesShape({ kind, ink }: { kind: FriendlyEyes; ink: string }) {
  switch (kind) {
    case "dot":
      return (
        <g fill={ink}>
          <circle cx="24" cy="32" r="2.4" />
          <circle cx="40" cy="32" r="2.4" />
        </g>
      );
    case "small":
      return (
        <g fill={ink}>
          <circle cx="24.5" cy="32" r="1.7" />
          <circle cx="39.5" cy="32" r="1.7" />
        </g>
      );
    case "sleep":
      return (
        <g stroke={ink} strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M20.5 32 Q24 34.4 27.5 32" />
          <path d="M36.5 32 Q40 34.4 43.5 32" />
        </g>
      );
    case "sparkle":
      return (
        <g fill={ink}>
          <Star cx={24} cy={32} r={3.2} />
          <Star cx={40} cy={32} r={3.2} />
        </g>
      );
    case "happy":
      return (
        <g
          stroke={ink}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M20.5 33.5 L24 30 L27.5 33.5" />
          <path d="M36.5 33.5 L40 30 L43.5 33.5" />
        </g>
      );
    case "anime":
      return (
        <g>
          <circle cx="24" cy="32" r="3.6" stroke={ink} strokeWidth="1.4" fill="none" />
          <circle cx="40" cy="32" r="3.6" stroke={ink} strokeWidth="1.4" fill="none" />
          <circle cx="24.6" cy="32.5" r="1.5" fill={ink} />
          <circle cx="40.6" cy="32.5" r="1.5" fill={ink} />
        </g>
      );
  }
}

function InkMouthShape({ kind, ink }: { kind: FriendlyMouth; ink: string }) {
  switch (kind) {
    case "smile":
      return (
        <path
          d="M26.5 42 Q32 46.5 37.5 42"
          stroke={ink}
          strokeWidth="1.8"
          strokeLinecap="round"
          fill="none"
        />
      );
    case "tinydot":
      return <circle cx="32" cy="43.5" r="1.3" fill={ink} />;
    case "wide":
      return (
        <path
          d="M25 41.5 Q32 49 39 41.5"
          stroke={ink}
          strokeWidth="1.8"
          strokeLinecap="round"
          fill="none"
        />
      );
    case "o":
      return (
        <circle cx="32" cy="43.5" r="2.5" stroke={ink} strokeWidth="1.6" fill="none" />
      );
    case "tongue":
      return (
        <g>
          <path
            d="M26.5 42 Q32 46.5 37.5 42"
            stroke={ink}
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="32" cy="45.4" r="1.7" fill={BLUSH} opacity="0.7" />
        </g>
      );
    case "line":
      return (
        <line
          x1="27.5"
          y1="43.5"
          x2="36.5"
          y2="43.5"
          stroke={ink}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      );
  }
}

function InkAccessoryShape({
  kind,
  ink,
}: {
  kind: FriendlyAccessory;
  ink: string;
}) {
  switch (kind) {
    case "none":
      return null;
    case "antenna":
      return (
        <g>
          <line x1="32" y1="13" x2="32" y2="7" />
          <circle cx="32" cy="5.5" r="2" />
        </g>
      );
    case "sparkle":
      return (
        <g fill={ink} stroke="none">
          <Star cx={49} cy={9} r={2.8} />
          <circle cx="44.5" cy="5" r="0.8" />
        </g>
      );
    case "tuft":
      return <path d="M28 12 Q30 4 32 10 Q34 3 36 11" />;
    case "ears":
      return (
        <g strokeLinejoin="round">
          <path d="M16 18 L17.5 8 L24 14" />
          <path d="M40 14 L46.5 8 L48 18" />
        </g>
      );
    case "halo":
      return <ellipse cx="32" cy="7" rx="9" ry="2.2" />;
  }
}

// ---------------------------------------------------------------------------
// Friendly — restored from the pre-alien implementation. Smooth rounded body
// with a gradient fill, soft top sheen, and a curved SVG face.
// ---------------------------------------------------------------------------

type FriendlyEyes = "dot" | "small" | "sleep" | "sparkle" | "happy" | "anime";
type FriendlyMouth = "smile" | "tinydot" | "wide" | "o" | "tongue" | "line";
type FriendlyAccessory =
  | "none"
  | "antenna"
  | "sparkle"
  | "tuft"
  | "ears"
  | "halo";

const FRIENDLY_EYES: FriendlyEyes[] = [
  "dot",
  "small",
  "sleep",
  "sparkle",
  "happy",
  "anime",
];
const FRIENDLY_MOUTHS: FriendlyMouth[] = [
  "smile",
  "tinydot",
  "wide",
  "o",
  "tongue",
  "line",
];
const FRIENDLY_ACCESSORIES: FriendlyAccessory[] = [
  "none",
  "antenna",
  "sparkle",
  "tuft",
  "ears",
  "halo",
  "none",
  "none",
];

const INK = "#1b1f36";
const TONGUE = "#ff7a8a";
const BLUSH = "#ff8aa3";
const HALO = "#fde68a";

function FriendlyAvatar({ id, className, title }: CharacterAvatarProps) {
  const h = hash(id);
  const palette = gradientFor(id);
  const eyes = FRIENDLY_EYES[(h >> 3) % FRIENDLY_EYES.length];
  const mouth = FRIENDLY_MOUTHS[(h >> 7) % FRIENDLY_MOUTHS.length];
  const accessory =
    FRIENDLY_ACCESSORIES[(h >> 11) % FRIENDLY_ACCESSORIES.length];
  const blush = ((h >> 17) & 1) === 1;
  const gid = `cha-${(h % 1_000_000).toString(36)}`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "avatar"}
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="50%" stopColor={palette.via} />
          <stop offset="100%" stopColor={palette.to} />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="64" height="64" rx="18" fill={`url(#${gid})`} />
      <ellipse cx="32" cy="11" rx="22" ry="7" fill="#ffffff" opacity="0.18" />
      <rect
        x="0"
        y="0"
        width="64"
        height="64"
        rx="18"
        fill="none"
        stroke="#000000"
        strokeOpacity="0.06"
        strokeWidth="1"
      />

      <FriendlyAccessoryShape kind={accessory} palette={palette} />
      {blush && <FriendlyBlush />}
      <FriendlyEyesShape kind={eyes} />
      <FriendlyMouthShape kind={mouth} />
    </svg>
  );
}

function FriendlyEyesShape({ kind }: { kind: FriendlyEyes }) {
  switch (kind) {
    case "dot":
      return (
        <g fill={INK}>
          <circle cx="22" cy="29" r="3.6" />
          <circle cx="42" cy="29" r="3.6" />
        </g>
      );
    case "small":
      return (
        <g fill={INK}>
          <circle cx="23" cy="29" r="2.4" />
          <circle cx="41" cy="29" r="2.4" />
        </g>
      );
    case "sleep":
      return (
        <g stroke={INK} strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M17.5 29 Q22 32 26.5 29" />
          <path d="M37.5 29 Q42 32 46.5 29" />
        </g>
      );
    case "sparkle":
      return (
        <g fill={INK}>
          <Star cx={22} cy={29} r={4} />
          <Star cx={42} cy={29} r={4} />
        </g>
      );
    case "happy":
      return (
        <g
          stroke={INK}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M17.5 30.5 L22 26 L26.5 30.5" />
          <path d="M37.5 30.5 L42 26 L46.5 30.5" />
        </g>
      );
    case "anime":
      return (
        <g>
          <circle cx="22" cy="29" r="5" fill="#ffffff" />
          <circle cx="42" cy="29" r="5" fill="#ffffff" />
          <circle cx="22.5" cy="29.5" r="2.6" fill={INK} />
          <circle cx="42.5" cy="29.5" r="2.6" fill={INK} />
          <circle cx="20.6" cy="28" r="0.9" fill="#ffffff" />
          <circle cx="40.6" cy="28" r="0.9" fill="#ffffff" />
        </g>
      );
  }
}

function FriendlyMouthShape({ kind }: { kind: FriendlyMouth }) {
  switch (kind) {
    case "smile":
      return (
        <path
          d="M25 42 Q32 48 39 42"
          stroke={INK}
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
      );
    case "tinydot":
      return <circle cx="32" cy="44" r="1.7" fill={INK} />;
    case "wide":
      return <path d="M22 42 Q32 52 42 42 Q32 46.5 22 42 Z" fill={INK} />;
    case "o":
      return (
        <circle
          cx="32"
          cy="44"
          r="3.2"
          stroke={INK}
          strokeWidth="2"
          fill="none"
        />
      );
    case "tongue":
      return (
        <g>
          <path
            d="M25 42 Q32 48 39 42"
            stroke={INK}
            strokeWidth="2.4"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="32" cy="46.2" r="2.1" fill={TONGUE} />
        </g>
      );
    case "line":
      return (
        <line
          x1="26"
          y1="44"
          x2="38"
          y2="44"
          stroke={INK}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      );
  }
}

function FriendlyAccessoryShape({
  kind,
  palette,
}: {
  kind: FriendlyAccessory;
  palette: { from: string; via: string; to: string };
}) {
  switch (kind) {
    case "none":
      return null;
    case "antenna":
      return (
        <g>
          <line
            x1="32"
            y1="11"
            x2="32"
            y2="5"
            stroke={INK}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle
            cx="32"
            cy="4.5"
            r="2.6"
            fill={palette.via}
            stroke={INK}
            strokeWidth="1.2"
          />
        </g>
      );
    case "sparkle":
      return (
        <g fill="#ffffff">
          <Star cx={50} cy={11} r={3.4} />
          <circle cx="46" cy="6" r="0.9" />
        </g>
      );
    case "tuft":
      return (
        <path d="M28 8 Q31 -1 35 6 Q37 0 39 7 Q34 10 28 8 Z" fill={INK} />
      );
    case "ears":
      return (
        <g fill={INK}>
          <path d="M9 12 L12 4 L17 11 Z" />
          <path d="M47 11 L52 4 L55 12 Z" />
        </g>
      );
    case "halo":
      return (
        <ellipse
          cx="32"
          cy="6"
          rx="11"
          ry="2.4"
          fill="none"
          stroke={HALO}
          strokeWidth="1.6"
        />
      );
  }
}

function FriendlyBlush() {
  return (
    <g fill={BLUSH} opacity="0.55">
      <ellipse cx="16" cy="38" rx="3.4" ry="2.2" />
      <ellipse cx="48" cy="38" rx="3.4" ry="2.2" />
    </g>
  );
}

function Star({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const k = r * 0.32;
  const d = [
    `M ${cx} ${cy - r}`,
    `Q ${cx + k} ${cy - k} ${cx + r} ${cy}`,
    `Q ${cx + k} ${cy + k} ${cx} ${cy + r}`,
    `Q ${cx - k} ${cy + k} ${cx - r} ${cy}`,
    `Q ${cx - k} ${cy - k} ${cx} ${cy - r}`,
    "Z",
  ].join(" ");
  return <path d={d} />;
}

// ---------------------------------------------------------------------------
// Kawaii — every avatar is unambiguously cute. Same gradient body, but face
// is fixed: big anime eyes, soft curved smile, pink blush. The hash only
// varies palette + which eye winks (or neither).
// ---------------------------------------------------------------------------

function KawaiiAvatar({ id, className, title }: CharacterAvatarProps) {
  const h = hash(id);
  const palette = gradientFor(id);
  // 0 = both open, 1 = left wink, 2 = right wink. Open-eyes weighted heavily.
  const winkRoll = (h >> 5) % 6;
  const wink: 0 | 1 | 2 = winkRoll === 0 ? 1 : winkRoll === 1 ? 2 : 0;
  const gid = `kaw-${(h % 1_000_000).toString(36)}`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "avatar"}
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="50%" stopColor={palette.via} />
          <stop offset="100%" stopColor={palette.to} />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="64" height="64" rx="20" fill={`url(#${gid})`} />
      <ellipse cx="32" cy="12" rx="22" ry="7" fill="#ffffff" opacity="0.22" />
      <rect
        x="0"
        y="0"
        width="64"
        height="64"
        rx="20"
        fill="none"
        stroke="#000000"
        strokeOpacity="0.06"
        strokeWidth="1"
      />

      {/* Always-on blush */}
      <g fill={BLUSH} opacity="0.6">
        <ellipse cx="15" cy="40" rx="4.2" ry="2.6" />
        <ellipse cx="49" cy="40" rx="4.2" ry="2.6" />
      </g>

      {/* Eyes */}
      {wink === 1 ? (
        <ClosedEye cx={22} cy={31} />
      ) : (
        <AnimeEye cx={22} cy={31} />
      )}
      {wink === 2 ? (
        <ClosedEye cx={42} cy={31} />
      ) : (
        <AnimeEye cx={42} cy={31} />
      )}

      {/* Soft smile */}
      <path
        d="M25 44 Q32 50 39 44"
        stroke={INK}
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function AnimeEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={5.4} fill="#ffffff" />
      <circle cx={cx + 0.5} cy={cy + 0.6} r={2.9} fill={INK} />
      <circle cx={cx - 1.4} cy={cy - 1.2} r={1.1} fill="#ffffff" />
    </g>
  );
}

function ClosedEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <path
      d={`M ${cx - 4.5} ${cy} Q ${cx} ${cy + 3.6} ${cx + 4.5} ${cy}`}
      stroke={INK}
      strokeWidth="2.4"
      strokeLinecap="round"
      fill="none"
    />
  );
}

// ---------------------------------------------------------------------------
// Pixel — the original pixel-art alien renderer, opt-in. 16×16 grid per
// species on a dark "screen" backdrop, palette-coloured body, deterministic
// mood/topper/mouth/blush.
// ---------------------------------------------------------------------------

type PixelSpecies = "stub" | "rocky" | "tower" | "bug" | "ghost" | "bot";
type PixelMood = "calm" | "happy" | "wink" | "sleepy" | "sparkle" | "wide";
type PixelTopper = "none" | "antenna" | "tuft" | "halo" | "ears";

const PIXEL_SPECIES_LIST: PixelSpecies[] = [
  "stub",
  "rocky",
  "tower",
  "bug",
  "ghost",
  "bot",
];
const PIXEL_MOOD_LIST: PixelMood[] = [
  "calm",
  "happy",
  "wink",
  "sleepy",
  "sparkle",
  "wide",
];
const PIXEL_TOPPER_LIST: PixelTopper[] = [
  "none",
  "none",
  "none",
  "none",
  "antenna",
  "tuft",
  "halo",
  "ears",
];
const PIXEL_MOUTH_LIST = [0, 0, 0, 0, 0, 1, 2, 3] as const;

const PIXEL_ALLOW_TOPPER: Record<PixelSpecies, boolean> = {
  stub: true,
  tower: false,
  ghost: false,
  rocky: false,
  bug: false,
  bot: false,
};

const PIXEL_ALLOW_BLUSH: Record<PixelSpecies, boolean> = {
  stub: true,
  ghost: true,
  bug: true,
  rocky: true,
  tower: false,
  bot: false,
};

const PX = 4;
const PIXEL_BACKDROP = "#1c1c1c";
const PIXEL_EYE = "#0d0d0f";
const PIXEL_SHINE = "#fafafa";
const PIXEL_HALO = "#fde68a";
const PIXEL_BLUSH = "#ff8aa3";

type Pos = readonly [number, number];

interface PixelSpeciesData {
  grid: string[];
  eyes: readonly [Pos, Pos];
}

const PIXEL_SPECIES_DATA: Record<PixelSpecies, PixelSpeciesData> = {
  stub: {
    grid: [
      "................",
      "................",
      "................",
      "................",
      "................",
      "....BBBBBBBB....",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...B.B....B.B...",
      "...B.B....B.B...",
      "................",
    ],
    eyes: [[5, 8], [9, 8]],
  },
  rocky: {
    grid: [
      "................",
      "................",
      ".......B........",
      ".......B........",
      "......BBB.......",
      "....BBBBBBB.....",
      "...BBBBBBBBB....",
      "...BBBBBBBBB....",
      "...BBBBBBBBB....",
      "...BBBBBBBBB....",
      "...BBBBBBBBB....",
      "....BBBBBBB.....",
      "....B.B.B.B.....",
      "...B...B...B....",
      "................",
      "................",
    ],
    eyes: [[5, 7], [9, 7]],
  },
  tower: {
    grid: [
      "................",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....BBBBBB.....",
      ".....B....B.....",
      ".....B....B.....",
      "................",
    ],
    eyes: [[5, 5], [9, 5]],
  },
  bug: {
    grid: [
      "................",
      "................",
      "....B......B....",
      "...B........B...",
      "...B........B...",
      ".....BBBBBB.....",
      "....BBBBBBBB....",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "....BBBBBBBB....",
      "....B......B....",
      "....B......B....",
      "................",
      "................",
    ],
    eyes: [[5, 8], [9, 8]],
  },
  ghost: {
    grid: [
      "................",
      "................",
      "......BBBB......",
      ".....BBBBBB.....",
      "....BBBBBBBB....",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BB..BB..BB...",
      "................",
      "................",
    ],
    eyes: [[5, 7], [9, 7]],
  },
  bot: {
    grid: [
      "................",
      "......BBB.......",
      ".......B........",
      ".......B........",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BBBBBBBBBB...",
      "...BB......BB...",
      "...BB......BB...",
      "................",
    ],
    eyes: [[5, 6], [9, 6]],
  },
};

function PixelAvatar({ id, className, title }: CharacterAvatarProps) {
  const h = hash(id);
  const palette = gradientFor(id);
  const species = PIXEL_SPECIES_LIST[(h >> 3) % PIXEL_SPECIES_LIST.length];
  const mood = PIXEL_MOOD_LIST[(h >> 7) % PIXEL_MOOD_LIST.length];
  const topperKind =
    PIXEL_TOPPER_LIST[(h >> 11) % PIXEL_TOPPER_LIST.length];
  const mouthKind = PIXEL_MOUTH_LIST[(h >> 15) % PIXEL_MOUTH_LIST.length];
  const blush = ((h >> 19) & 1) === 1;

  const data = PIXEL_SPECIES_DATA[species];
  const body = palette.from;
  const accent = palette.via;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "avatar"}
      className={className}
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={0} y={0} width={64} height={64} rx={14} fill={PIXEL_BACKDROP} />
      {renderPixelGrid(data.grid, body)}
      {PIXEL_ALLOW_TOPPER[species] && (
        <PixelTopperShape kind={topperKind} accent={accent} />
      )}
      <PixelMouthShape kind={mouthKind} />
      {blush && PIXEL_ALLOW_BLUSH[species] && <PixelBlushShape />}
      <PixelEyeShape
        col={data.eyes[0][0]}
        row={data.eyes[0][1]}
        mood={mood}
        side="left"
      />
      <PixelEyeShape
        col={data.eyes[1][0]}
        row={data.eyes[1][1]}
        mood={mood}
        side="right"
      />
    </svg>
  );
}

function renderPixelGrid(grid: string[], body: string) {
  const rects: ReactElement[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    let c = 0;
    while (c < row.length) {
      if (row[c] === "B") {
        let end = c;
        while (end < row.length && row[end] === "B") end++;
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={c * PX}
            y={r * PX}
            width={(end - c) * PX}
            height={PX}
            fill={body}
          />,
        );
        c = end;
      } else {
        c++;
      }
    }
  }
  return <g>{rects}</g>;
}

function PixelEyeShape({
  col,
  row,
  mood,
  side,
}: {
  col: number;
  row: number;
  mood: PixelMood;
  side: "left" | "right";
}) {
  const x = col * PX;
  const y = row * PX;

  switch (mood) {
    case "calm":
      return <rect x={x} y={y} width={PX * 2} height={PX * 2} fill={PIXEL_EYE} />;
    case "wide":
      return (
        <rect
          x={x - 1}
          y={y - 1}
          width={PX * 2 + 2}
          height={PX * 2 + 2}
          fill={PIXEL_EYE}
        />
      );
    case "sleepy":
      return (
        <rect x={x} y={y + PX} width={PX * 2} height={PX} fill={PIXEL_EYE} />
      );
    case "happy":
      return (
        <rect
          x={x + PX / 2}
          y={y + PX / 2}
          width={PX}
          height={PX}
          fill={PIXEL_EYE}
        />
      );
    case "wink":
      if (side === "left") {
        return (
          <rect x={x} y={y} width={PX * 2} height={PX * 2} fill={PIXEL_EYE} />
        );
      }
      return (
        <rect x={x} y={y + PX} width={PX * 2} height={PX} fill={PIXEL_EYE} />
      );
    case "sparkle":
      return (
        <g>
          <rect x={x} y={y} width={PX * 2} height={PX * 2} fill={PIXEL_EYE} />
          <rect x={x} y={y} width={PX} height={PX} fill={PIXEL_SHINE} />
        </g>
      );
  }
}

function PixelMouthShape({ kind }: { kind: number }) {
  switch (kind) {
    case 0:
      return null;
    case 1:
      return <rect x={30} y={44} width={4} height={4} fill={PIXEL_EYE} />;
    case 2:
      return <rect x={26} y={44} width={12} height={4} fill={PIXEL_EYE} />;
    case 3:
      return <rect x={30} y={42} width={4} height={8} fill={PIXEL_EYE} />;
    default:
      return null;
  }
}

function PixelTopperShape({
  kind,
  accent,
}: {
  kind: PixelTopper;
  accent: string;
}) {
  switch (kind) {
    case "none":
      return null;
    case "antenna":
      return (
        <g fill={accent}>
          <rect x={30} y={10} width={4} height={10} />
          <rect x={26} y={4} width={12} height={4} />
        </g>
      );
    case "tuft":
      return (
        <g fill={accent}>
          <rect x={24} y={16} width={4} height={4} />
          <rect x={30} y={10} width={4} height={6} />
          <rect x={36} y={16} width={4} height={4} />
        </g>
      );
    case "halo":
      return <rect x={20} y={10} width={24} height={3} fill={PIXEL_HALO} />;
    case "ears":
      return (
        <g fill={accent}>
          <rect x={14} y={16} width={4} height={4} />
          <rect x={46} y={16} width={4} height={4} />
        </g>
      );
  }
}

function PixelBlushShape() {
  return (
    <g fill={PIXEL_BLUSH} opacity={0.6}>
      <rect x={14} y={36} width={4} height={4} />
      <rect x={46} y={36} width={4} height={4} />
    </g>
  );
}
