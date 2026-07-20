import { useState } from "react";
import type { Profile } from "../types";

export function Toolbar({
  count,
  profile,
  info,
  onProfile,
  onAdd,
  onFill,
  onExport,
}: {
  count: number;
  profile: Profile;
  info: string | null;
  onProfile: (p: Profile) => void;
  onAdd: (company: string, role: string) => Promise<void>;
  onFill: (onProgress: (d: number, t: number) => void) => Promise<void>;
  onExport: () => void;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [adding, setAdding] = useState(false);
  const [filling, setFilling] = useState(false);
  const [progress, setProgress] = useState<{ d: number; t: number } | null>(null);
  const [showResume, setShowResume] = useState(false);

  const add = async () => {
    if (adding || !company.trim()) return;
    setAdding(true);
    try {
      await onAdd(company.trim(), role.trim());
      setCompany("");
      setRole("");
    } finally {
      setAdding(false);
    }
  };

  const fill = async () => {
    if (filling) return;
    setFilling(true);
    setProgress({ d: 0, t: 0 });
    try {
      await onFill((d, t) => setProgress({ d, t }));
    } finally {
      setFilling(false);
      setProgress(null);
    }
  };

  return (
    <>
      <div className="bar">
        <div className="grow">
          <div className="title">Job Search Tracker</div>
          <div className="sub">
            {count} compan{count === 1 ? "y" : "ies"}
            {info ? ` · ${info}` : ""}
          </div>
        </div>
        <input
          className="grow"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="Company (e.g. Anthropic)"
          disabled={adding}
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="Role (optional)"
          disabled={adding}
          style={{ width: 170 }}
        />
        <button className="go" onClick={() => void add()} disabled={adding || !company.trim()}>
          {adding ? <span className="spin" /> : "✨"} {adding ? "Researching…" : "Research & add"}
        </button>
        <button onClick={() => void fill()} disabled={filling || count === 0}>
          {filling ? <span className="spin" /> : "🪄"}{" "}
          {filling ? `Filling ${progress?.d ?? 0}/${progress?.t ?? 0}` : "Fill gaps"}
        </button>
        <button onClick={() => setShowResume((s) => !s)}>
          {profile.resume ? "Resume ✓" : "Resume"}
        </button>
        <button onClick={onExport} disabled={count === 0}>
          ⬇ Export
        </button>
      </div>
      {showResume && (
        <div className="panel">
          <div className="label">Your resume / background (saved once, used for every outreach)</div>
          <input
            className="full"
            style={{ marginBottom: 8 }}
            value={profile.role}
            onChange={(e) => onProfile({ ...profile, role: e.target.value })}
            placeholder="Your target role (e.g. Staff Software Engineer)"
          />
          <textarea
            className="ta full"
            rows={5}
            value={profile.resume}
            onChange={(e) => onProfile({ ...profile, resume: e.target.value })}
            placeholder="Paste your resume / background"
          />
          <div className="note" style={{ marginTop: 4 }}>
            Saved to this app, reused for every company.
          </div>
        </div>
      )}
    </>
  );
}
