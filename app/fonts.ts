import { Inter, JetBrains_Mono, Lora, Nunito_Sans, Source_Serif_4 } from "next/font/google";

// Bundled font families. Each exposes a CSS variable (set on <html> in the
// root layout) that the font registry in lib/fonts.ts stitches into a full
// font-family stack. Variable axes keep every file small; italics matter for
// the serifs because bylines and blockquotes lean on them.
//
// `--font-serif-web` keeps its historical name so the existing
// `--font-display` fallback in globals.css still resolves.
export const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-serif-web",
  display: "swap",
});

export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-nunito",
  display: "swap",
});

export const lora = Lora({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-lora",
  display: "swap",
});

export const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

// Space-joined list of every font's `.variable` class, applied to <html> so
// the `var(--font-*)` references in the registry are always defined.
export const fontVariableClassName = [
  sourceSerif,
  inter,
  nunitoSans,
  lora,
  jetBrainsMono,
].map((f) => f.variable).join(" ");
