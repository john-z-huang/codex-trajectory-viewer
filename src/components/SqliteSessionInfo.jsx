import { useState } from "react";

function fieldText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function sandboxPolicySummary(value) {
  let policy = value;
  if (typeof value === "string") {
    try { policy = JSON.parse(value); } catch { /* 旧格式和非 JSON 配置使用短预览。 */ }
  }
  const type = typeof policy?.type === "string" ? policy.type : null;
  const text = (type ?? fieldText(value)).replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  const preview = characters.slice(0, 120).join("");
  if (type !== null) return `${preview}${characters.length > 120 ? "…" : ""}（详细配置已省略）`;
  return characters.length > 120 ? `${preview}…（已省略）` : text;
}

function SessionInfoRow({ database, row }) {
  const [rawOpen, setRawOpen] = useState(false);

  return (
    <div className="sqlite-session-info-record">
      <dl className="sqlite-session-info-row">
        {Object.entries(row ?? {}).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{database === "state_5.sqlite" && key === "sandbox_policy" ? sandboxPolicySummary(value) : fieldText(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="sqlite-session-info-raw" onToggle={(event) => setRawOpen(event.currentTarget.open)}>
        <summary>原始 JSON</summary>
        {rawOpen && <pre className="sqlite-row">{JSON.stringify(row, null, 2)}</pre>}
      </details>
    </div>
  );
}

export function SqliteSessionInfo({ database, table }) {
  const rows = Array.isArray(table.rows) ? table.rows : [];

  return (
    <section className="sqlite-session-info-table">
      <h3>{table.table} <span>{rows.length} 条</span></h3>
      {table.reason && <p className="source-note">{table.reason}</p>}
      {!rows.length && !table.reason && <p className="source-note">没有关联记录</p>}
      {rows.map((row, index) => (
        <SessionInfoRow database={database} row={row} key={index} />
      ))}
    </section>
  );
}
