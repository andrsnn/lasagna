import { useState } from "react";
import type { Profile, Row } from "../types";
import { COLUMNS } from "../types";
import { writeOutreach, writeWhy } from "../sdk";

export function RowDrawer({
  row,
  profile,
  onClose,
  onPatch,
  onDelete,
}: {
  row: Row;
  profile: Profile;
  onClose: () => void;
  onPatch: (id: string, patch: Partial<Row>) => void;
  onDelete: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"outreach" | "why" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const draft = async (kind: "outreach" | "why") => {
    if (busy) return;
    setBusy(kind);
    setErr(null);
    try {
      const text = kind === "outreach" ? await writeOutreach(row, profile) : await writeWhy(row, profile);
      onPatch(row.id, { [kind]: text } as Partial<Row>);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="title" style={{ minWidth: 0 }}>
            {row.company || "Company"}
          </div>
          <div className="rowflex">
            <button onClick={() => onDelete(row.id)} title="Delete this company">🗑</button>
            <button onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="drawer-body">
          {err && <div className="err" style={{ borderRadius: 6, marginBottom: 8 }}>{err}</div>}

          {COLUMNS.filter((c) => c.key !== "company").map((c) => {
            const v = row[c.key];
            if (v == null || String(v).trim() === "") return null;
            return (
              <div className="field" key={c.key}>
                <div className="label">{c.label}</div>
                <div className="value">{String(v)}</div>
              </div>
            );
          })}

          <div className="section">
            <div className="label">Applying for</div>
            <input
              className="full"
              value={row.appliedRole || ""}
              onChange={(e) => onPatch(row.id, { appliedRole: e.target.value })}
              placeholder="Role title, or paste the job link"
            />
            <div className="row-actions">
              <button className="go" onClick={() => void draft("outreach")} disabled={busy === "outreach"}>
                {busy === "outreach" ? <span className="spin" /> : "✨"}{" "}
                {row.outreach ? "Re-write outreach" : "Write outreach"}
              </button>
              <button onClick={() => void draft("why")} disabled={busy === "why"}>
                {busy === "why" ? <span className="spin" /> : "✨"}{" "}
                {row.why ? "Re-write “why here”" : "Why I want to work here"}
              </button>
            </div>
          </div>

          {row.outreach != null && (
            <div className="section">
              <div className="label">Outreach message</div>
              <textarea
                className="ta full"
                rows={5}
                value={row.outreach}
                onChange={(e) => onPatch(row.id, { outreach: e.target.value })}
              />
              <button style={{ marginTop: 4 }} onClick={() => navigator.clipboard?.writeText(row.outreach || "")}>
                Copy
              </button>
            </div>
          )}

          {row.why != null && (
            <div className="section">
              <div className="label">Why I want to work here</div>
              <textarea
                className="ta full"
                rows={5}
                value={row.why}
                onChange={(e) => onPatch(row.id, { why: e.target.value })}
              />
              <button style={{ marginTop: 4 }} onClick={() => navigator.clipboard?.writeText(row.why || "")}>
                Copy
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
