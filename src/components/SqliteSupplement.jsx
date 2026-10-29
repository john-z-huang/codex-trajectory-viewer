import { useCallback, useMemo, useState } from "react";
import { SqliteSessionInfo } from "./SqliteSessionInfo.jsx";
import { Timeline } from "./Timeline.jsx";
import { projectSqliteTimelineRow, SQLITE_ITEM_TYPES } from "../lib/sqlite-history.js";

const EMPTY_ROWS = Object.freeze([]);

function SqliteHistoryTimeline({ table, active, historyLoading, onLoadHistoryPage, historySearchLoading, onSearchHistory, revision }) {
  const rows = Array.isArray(table.rows) ? table.rows : EMPTY_ROWS;
  const pageSize = table.pagination?.pageSize ?? 50;
  const page = table.pagination?.page ?? 1;
  const startLine = (page - 1) * pageSize + 1;
  const [currentLine, setCurrentLine] = useState(0);
  const entries = useMemo(() => rows.map((row, index) => projectSqliteTimelineRow(row, startLine + index, revision ?? "sqlite")), [rows, startLine, revision]);
  const rollout = useMemo(() => ({
    revision: revision ?? "sqlite", startLine, pageSize,
    totalLines: table.pagination?.totalRows ?? rows.length,
  }), [revision, startLine, pageSize, table.pagination?.totalRows, rows.length]);
  const navigateLine = useCallback((line) => {
    setCurrentLine(line);
    const targetPage = Math.floor((line - 1) / pageSize) + 1;
    if (targetPage !== page) return onLoadHistoryPage?.(targetPage);
    return undefined;
  }, [onLoadHistoryPage, page, pageSize]);
  const search = useCallback(async (query, afterIndex) => {
    const result = await onSearchHistory(query, afterIndex);
    return result === undefined ? undefined : result.rowIndex;
  }, [onSearchHistory]);

  return (
    <Timeline
      entries={entries}
      rollout={rollout}
      currentLine={currentLine}
      active={active}
      pageLoading={historyLoading}
      searchLoading={historySearchLoading}
      onNavigateLine={navigateLine}
      onSearch={onSearchHistory ? search : undefined}
      source="sqlite"
      recordTypes={SQLITE_ITEM_TYPES}
    />
  );
}

function SourceHeading({ source, title = source.database }) {
  return (
    <>
      <div className="sqlite-source-heading">
        <strong>{title}</strong>
        <span className={source.available ? "source-ok" : "source-muted"}>{source.available ? "已读取" : "不可用"}</span>
      </div>
      {source.error && <p className="source-note">{source.error}</p>}
    </>
  );
}

export function SqliteSupplement({ sources, active = true, historyLoading, onLoadHistoryPage, historySearchLoading, onSearchHistory, revision }) {
  const sessionSources = (sources ?? []).filter((source) => source.database !== "thread_history_1.sqlite");
  const historySources = (sources ?? []).filter((source) => source.database === "thread_history_1.sqlite");
  const rank = (source) => source.database === "state_5.sqlite" ? 0 : source.database === "goals_1.sqlite" ? 1 : 2;
  const orderedSessionSources = [...sessionSources].sort((left, right) => rank(left) - rank(right));

  return (
    <section className="sqlite-section">
      <section className="sqlite-session-info" aria-label="会话说明与轮次记录">
        <div className="timeline-label"><h2>会话说明与轮次记录</h2><span>按会话 ID 关联 · 只读</span></div>
        <div className="sqlite-sources">
          {orderedSessionSources.map((source) => (
            <article className="sqlite-source" key={source.database}>
              <SourceHeading source={source} />
              {source.tables?.map((table) => <SqliteSessionInfo database={source.database} table={table} key={table.table} />)}
            </article>
          ))}
          {historySources.map((source) => (
            <article className="sqlite-source" key={source.database}>
              <SourceHeading source={source} title="轮次记录" />
              {source.tables?.filter((table) => table.table !== "thread_items").map((table) => <SqliteSessionInfo database={source.database} table={table} key={table.table} />)}
            </article>
          ))}
        </div>
      </section>
      <section className="sqlite-conversation" aria-label="SQLite 历史对话">
        {historySources.map((source) => (
          <div className="sqlite-history-source" key={source.database}>
            <SourceHeading source={source} />
            {source.tables?.filter((table) => table.table === "thread_items").map((table) => (
              <div key={table.table}>
                {table.reason && <p className="source-note">{table.reason}</p>}
                <SqliteHistoryTimeline {...{ table, active, historyLoading, onLoadHistoryPage, historySearchLoading, onSearchHistory, revision }} />
              </div>
            ))}
          </div>
        ))}
        {!historySources.length && <p className="source-note">没有 SQLite 历史对话来源</p>}
      </section>
    </section>
  );
}
