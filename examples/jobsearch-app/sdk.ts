// Thin wrappers over the host-injected window.artifact SDK + the AI prompts
// this app uses. Keeping all artifact.* access here means the components never
// touch the global directly.
import type { Profile, Row } from "./types";
import { RESEARCH_KEYS, blank } from "./types";

// window.artifact is injected by the host before our code runs (esbuild strips
// types, so an untyped global access is fine).
const A: any = (window as any).artifact;

export const ready = (): Promise<void> => A.ready();

export async function getState<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await A.state.get(key);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}
export function setState(key: string, value: unknown): void {
  try {
    A.state.set(key, value);
  } catch {
    /* best effort */
  }
}

export function downloadJson(content: unknown, filename: string): void {
  A.download(JSON.stringify(content, null, 2), filename, "application/json");
}

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    what: { type: "string" },
    fit: { type: "string" },
    contact: { type: "string" },
    link: { type: "string" },
    roles: { type: "string" },
    stage: { type: "string" },
    comp: { type: "string" },
  },
  required: RESEARCH_KEYS,
};

function fieldGuide(role: string): string {
  return [
    '"what" = what they do: product, who the customer is, the use case, and how the business is doing at a glance.',
    '"fit" = why I would be a strong, specific fit given my background.',
    '"contact" = a specific person worth reaching out to (name + title).',
    '"link" = their LinkedIn or profile URL.',
    `"roles" = current open roles${role ? `, prioritizing "${role}"` : ""}.`,
    '"stage" = funding stage / size.',
    '"comp" = compensation + equity range.',
  ].join("\n");
}

// Research ONE company and return the filled research fields.
export async function researchCompany(
  company: string,
  role: string,
  profile: Profile,
  webSearch = true
): Promise<Partial<Row>> {
  const prompt = [
    `Research the company "${company}" for a job seeker${role ? ` targeting a "${role}" role` : ""}.`,
    profile.resume ? `MY BACKGROUND:\n${profile.resume}` : "",
    `Fill EVERY field with concrete, current info${webSearch ? " (use web search)" : " from what you know"}:`,
    fieldGuide(role),
    "Do not invent names/links; if unknown, say so briefly.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await A.query(prompt, { schema: RESEARCH_SCHEMA, webSearch });
  return (r && r.json ? r.json : {}) as Partial<Row>;
}

// Fill the missing research fields across many rows in parallel (fast: no web,
// derive from each row's existing data). Returns a map of rowId -> patch.
export async function fillGaps(
  rows: Row[],
  profile: Profile,
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, Partial<Row>>> {
  const todo = rows.filter((r) => RESEARCH_KEYS.some((k) => blank(r[k])));
  const patches: Record<string, Partial<Row>> = {};
  if (todo.length === 0) return patches;
  const items = todo.map((r) => {
    const known = [
      `Company: ${r.company}`,
      ...RESEARCH_KEYS.filter((k) => !blank(r[k])).map((k) => `${k}: ${String(r[k])}`),
    ].join("\n");
    return {
      prompt: [
        `Fill the MISSING fields for this company, grounded in what's already known.`,
        profile.resume ? `MY BACKGROUND:\n${profile.resume}` : "",
        `KNOWN:\n${known}`,
        fieldGuide(profile.role),
      ]
        .filter(Boolean)
        .join("\n\n"),
      opts: { schema: RESEARCH_SCHEMA, webSearch: false },
    };
  });
  const results = await A.batchQuery(items, { concurrency: 4 });
  let done = 0;
  results.forEach((res: any, i: number) => {
    done++;
    onProgress?.(done, todo.length);
    if (!res || !res.ok || !res.value || !res.value.json) return;
    const json = res.value.json as Partial<Row>;
    const patch: Partial<Row> = {};
    for (const k of RESEARCH_KEYS) {
      if (blank(todo[i][k]) && !blank(json[k])) (patch as any)[k] = json[k];
    }
    if (Object.keys(patch).length) patches[todo[i].id] = patch;
  });
  return patches;
}

export async function writeOutreach(row: Row, profile: Profile): Promise<string> {
  const applied = (row.appliedRole || "").trim();
  const isLink = /^https?:\/\//i.test(applied);
  const roleClause = isLink
    ? `the role at this link (open it): ${applied}`
    : applied
      ? `their "${applied}" role`
      : profile.role
        ? `a ${profile.role} role`
        : "a role on their team";
  const prompt = [
    `Write a short, warm outreach message (about 80-120 words) from me to ${row.contact || "someone on the team"} at ${row.company} about ${roleClause}.`,
    profile.resume ? `MY BACKGROUND:\n${profile.resume}` : "",
    row.what ? `WHAT THEY DO:\n${row.what}` : "",
    "Use my background to show why I'm a specific, strong fit, reference something real about the company, and end with a light ask to connect. Sound human - no buzzwords. Output ONLY the message text.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await A.query(prompt, { webSearch: isLink });
  return (r && r.text) || "";
}

export async function writeWhy(row: Row, profile: Profile): Promise<string> {
  const prompt = [
    `Write a genuine "Why I want to work here" paragraph (about 60-100 words) for my application to ${row.company}${row.appliedRole ? ` for the "${row.appliedRole}" role` : ""}.`,
    profile.resume ? `MY BACKGROUND:\n${profile.resume}` : "",
    row.what ? `WHAT THEY DO:\n${row.what}` : "",
    "Connect my background to what they actually do and why it matters to me. First person, specific, no clichés. Output ONLY the paragraph.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await A.query(prompt, { webSearch: false });
  return (r && r.text) || "";
}
