import { useState } from "react";

function SqliteTable({ table, historyLoading, onLoadHistoryPage }) {
  const [open, setOpen] = useState(false);

  return (
    <details className="sqlite-table" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {table.table}
        <span>{table.rows?.length ? `${table.rows.length} 条` : table.reason ?? "没有关联记录"}</span>
      </summary>
      {open && table.reason && <p className="source-note">{table.reason}</p>}
      {open && table.rows?.slice(0, 50).map((row, index) => {
        const serializedRow = JSON.stringify(row, null, 2);
        return (
          <pre className="sqlite-row" key={`${table.table}-${index}`}>
            {serializedRow.slice(0, 12_000)}
            {serializedRow.length > 12_000 ? "… [row truncated]" : ""}
          </pre>
        );
      })}
      {open && table.pagination && (
        <div className="history-pager">
          <span>第 {table.pagination.page} 页，共 {table.pagination.totalRows} 条</span>
          <button
            onClick={() => onLoadHistoryPage(table.pagination.page - 1)}
            disabled={historyLoading || table.pagination.page <= 1}
          >
            上一页
          </button>
          <button
            onClick={() => onLoadHistoryPage(table.pagination.page + 1)}
            disabled={historyLoading || !table.pagination.hasMore}
          >
            下一页
          </button>
        </div>
      )}
    </details>
  );
}

export function SqliteSupplement({ sources, historyLoading, onLoadHistoryPage }) {
  return (
    <section className="sqlite-section">
      <div className="timeline-label">
        <h2>SQLite 补充数据</h2>
        <span>按会话 ID 关联 · 只读</span>
      </div>
      <div className="sqlite-sources">
        {(sources ?? []).map((source) => (
          <article className="sqlite-source" key={source.database}>
            <div className="sqlite-source-heading">
              <strong>{source.database}</strong>
              <span className={source.available ? "source-ok" : "source-muted"}>
                {source.available ? "已读取" : "不可用"}
              </span>
            </div>
            {source.error && <p className="source-note">{source.error}</p>}
            {source.tables?.map((table) => (
              <SqliteTable
                table={table}
                key={table.table}
                historyLoading={historyLoading}
                onLoadHistoryPage={onLoadHistoryPage}
              />
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
