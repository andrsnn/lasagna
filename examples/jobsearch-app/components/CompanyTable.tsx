import type { Row } from "../types";
import { COLUMNS } from "../types";

function Cell({ col, value }: { col: keyof Row; value: unknown }) {
  const s = value == null ? "" : String(value);
  if (!s) return <span className="empty">—</span>;
  if (col === "link" && /^https?:\/\//i.test(s)) {
    let label = s;
    try {
      label = new URL(s).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    return (
      <a href={s} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {label}
      </a>
    );
  }
  return <span className="value">{s}</span>;
}

export function CompanyTable({ rows, onOpen }: { rows: Row[]; onOpen: (r: Row) => void }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row" onClick={() => onOpen(r)} title="Open · draft outreach">
              {COLUMNS.map((c) => (
                <td key={c.key}>
                  <Cell col={c.key} value={r[c.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
