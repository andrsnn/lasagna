import { useEffect, useRef, useState } from "react";
import type { Profile, Row } from "./types";
import { getState, setState, downloadJson, researchCompany, fillGaps } from "./sdk";
import { Toolbar } from "./components/Toolbar";
import { CompanyTable } from "./components/CompanyTable";
import { RowDrawer } from "./components/RowDrawer";

const newId = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [profile, setProfile] = useState<Profile>({ resume: "", role: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    (async () => {
      setRows(await getState<Row[]>("rows", []));
      setProfile(await getState<Profile>("profile", { resume: "", role: "" }));
      hydrated.current = true;
    })();
  }, []);

  // Persist rows/profile after hydration (never clobber with the empty initial).
  useEffect(() => {
    if (hydrated.current) setState("rows", rows);
  }, [rows]);
  useEffect(() => {
    if (hydrated.current) setState("profile", profile);
  }, [profile]);

  const patchRow = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const deleteRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const addCompany = async (company: string, role: string) => {
    setError(null);
    setInfo(null);
    const key = norm(company);
    const existing = rows.find((r) => norm(r.company) === key);
    try {
      const fields = await researchCompany(company, role, profile, true);
      if (existing) {
        patchRow(existing.id, { ...fields, company, appliedRole: role || existing.appliedRole });
        setInfo(`Updated ${company}`);
      } else {
        const row: Row = {
          id: newId(),
          company,
          what: "",
          fit: "",
          contact: "",
          link: "",
          roles: "",
          stage: "",
          comp: "",
          ...fields,
          appliedRole: role || undefined,
        };
        setRows((rs) => [row, ...rs]);
        setInfo(`Added ${company}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const fill = async (onProgress: (d: number, t: number) => void) => {
    setError(null);
    setInfo(null);
    try {
      const patches = await fillGaps(rows, profile, onProgress);
      const n = Object.keys(patches).length;
      if (n) setRows((rs) => rs.map((r) => (patches[r.id] ? { ...r, ...patches[r.id] } : r)));
      setInfo(n ? `Filled gaps in ${n} row(s)` : "No missing fields");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportData = () =>
    downloadJson({ type: "job-search-tracker", exportedAt: Date.now(), profile, rows }, "job-search.json");

  const selected = rows.find((r) => r.id === selectedId) || null;

  return (
    <div className="app">
      <Toolbar
        count={rows.length}
        profile={profile}
        info={info}
        onProfile={setProfile}
        onAdd={addCompany}
        onFill={fill}
        onExport={exportData}
      />
      {error && <div className="err">{error}</div>}
      {rows.length === 0 ? (
        <div className="center">
          <div>No companies yet.</div>
          <div className="note">Add a company above - it researches it and fills the row.</div>
        </div>
      ) : (
        <CompanyTable rows={rows} onOpen={(r) => setSelectedId(r.id)} />
      )}
      {selected && (
        <RowDrawer
          row={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onPatch={patchRow}
          onDelete={deleteRow}
        />
      )}
    </div>
  );
}
