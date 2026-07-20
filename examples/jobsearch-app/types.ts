export type Row = {
  id: string;
  company: string;
  what: string; // What they do: product, customer, use case, traction
  fit: string; // Why I'd be a fit
  contact: string; // A person to reach out to
  link: string; // Contact / profile link
  roles: string; // Current open roles
  stage: string; // Funding / stage
  comp: string; // Comp / equity range
  appliedRole?: string; // The role you're targeting for this company
  outreach?: string; // Drafted outreach message
  why?: string; // "Why I want to work here"
};

export type Profile = { resume: string; role: string };

export type Column = { key: keyof Row; label: string };

// The columns shown in the table (the AI-researched fields).
export const COLUMNS: Column[] = [
  { key: "company", label: "Company" },
  { key: "what", label: "What they do" },
  { key: "fit", label: "Why a fit" },
  { key: "contact", label: "Contact" },
  { key: "link", label: "Link" },
  { key: "roles", label: "Open roles" },
  { key: "stage", label: "Stage" },
  { key: "comp", label: "Comp / equity" },
];

// Fields the AI research fills (everything except identity + per-row drafts).
export const RESEARCH_KEYS: (keyof Row)[] = [
  "what",
  "fit",
  "contact",
  "link",
  "roles",
  "stage",
  "comp",
];

export const blank = (v: unknown) => v == null || String(v).trim() === "";
