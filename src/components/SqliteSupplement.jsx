import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SqliteHistoryCard } from "./SqliteHistoryCard.jsx";
import { ConversationTypeFilter } from "./ConversationTypeFilter.jsx";
import { recordFilterType } from "../lib/conversation-types.js";
import { SQLITE_ITEM_TYPES, sqliteItemType } from "../lib/sqlite-history.js";

const EMPTY_ROWS = Object.freeze([]);

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function SqliteTable({ table, active, historyLoading, onLoadHistoryPage }) {
  const [open, setOpen] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set());
  const [visibleCardIndices, setVisibleCardIndices] = useState(new Set());
  const [navigationStatus, setNavigationStatus] = useState("");
  const tableRef = useRef(null);
  const activeRef = useRef(active);
  const historyLoadingRef = useRef(historyLoading);
  const observerEpochRef = useRef(0);
  const pendingBoundaryRef = useRef(null);
  const rows = Array.isArray(table.rows) ? table.rows : EMPTY_ROWS;
  const typedRows = useMemo(() => rows.map((row, index) => ({
    row,
    index,
    type: open && table.table === "thread_items" ? recordFilterType(sqliteItemType(row), SQLITE_ITEM_TYPES) : null,
  })), [rows, table.table, open]);
  const visibleRows = useMemo(() => typedRows.filter(({ type }) => type === null || !hiddenTypes.has(type)), [typedRows, hiddenTypes]);
  const pagination = table.pagination;
  const page = Number.isSafeInteger(pagination?.page) ? pagination.page : 0;
  const totalRows = Number.isSafeInteger(pagination?.totalRows) ? pagination.totalRows : 0;
  const pageSize = Number.isSafeInteger(pagination?.pageSize) && pagination.pageSize > 0 ? pagination.pageSize : 50;
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / pageSize) : 0;

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!open || !active) {
      setVisibleCardIndices(new Set());
      return undefined;
    }

    const cards = [...(tableRef.current?.querySelectorAll(".sqlite-history-card") ?? [])];
    const IntersectionObserverImpl = globalThis.IntersectionObserver;
    if (typeof IntersectionObserverImpl !== "function") {
      setVisibleCardIndices(new Set(cards.map((card) => Number(card.dataset.sqliteIndex))));
      return undefined;
    }

    const observerEpoch = observerEpochRef.current + 1;
    observerEpochRef.current = observerEpoch;
    setVisibleCardIndices(new Set());
    const root = tableRef.current?.closest(".session-tab-panel") ?? null;
    const observer = new IntersectionObserverImpl((entries) => {
      if (!activeRef.current || observerEpochRef.current !== observerEpoch) return;
      setVisibleCardIndices((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const index = Number(entry.target.dataset.sqliteIndex);
          if (!Number.isSafeInteger(index)) continue;
          if (entry.isIntersecting) next.add(index);
          else next.delete(index);
        }
        return sameSet(current, next) ? current : next;
      });
    }, { root, threshold: 0.01 });

    cards.forEach((card) => observer.observe(card));
    return () => {
      observer.disconnect();
      if (observerEpochRef.current === observerEpoch) observerEpochRef.current += 1;
    };
  }, [active, open, visibleRows]);

  function focusCard(direction) {
    if (!activeRef.current || !open) return false;
    const targetIndex = (direction === "first" ? visibleRows[0] : visibleRows.at(-1))?.index;
    const card = tableRef.current?.querySelector(`[data-sqlite-index="${targetIndex}"]`);
    if (!card) return false;
    card.focus?.({ preventScroll: true });
    const panel = card.closest(".session-tab-panel");
    const panelRect = panel?.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportHeight = panel?.clientHeight || panelRect?.height || 0;
    if (panel && panelRect) {
      const targetTop = direction === "first"
        ? panel.scrollTop + cardRect.top - panelRect.top
        : panel.scrollTop + cardRect.bottom - panelRect.top - viewportHeight;
      const maxScrollTop = Math.max(0, panel.scrollHeight - viewportHeight);
      panel.scrollTo?.({ top: Math.max(0, Math.min(targetTop, maxScrollTop)), behavior: "smooth" });
    } else {
      card.scrollIntoView?.({ block: direction === "first" ? "start" : "end", behavior: "smooth" });
    }
    return true;
  }

  function navigateBoundary(event, direction) {
    if (!activeRef.current || !open) return;
    if (!rows.length) {
      setNavigationStatus("没有可定位的 SQLite 历史记录。");
      return;
    }
    if (!pagination) {
      setNavigationStatus("");
      if (!focusCard(direction)) setNavigationStatus("当前 SQLite 数据没有可显示的记录。");
      return;
    }
    if (totalPages < 1) {
      setNavigationStatus("没有可定位的 SQLite 历史记录。");
      return;
    }
    const targetPage = direction === "first" ? 1 : totalPages;
    setNavigationStatus("");
    if (page === targetPage) {
      if (!focusCard(direction)) setNavigationStatus("当前 SQLite 历史页没有可显示的记录。");
      return;
    }
    if (typeof onLoadHistoryPage !== "function") {
      setNavigationStatus("SQLite 历史分页读取不可用。");
      return;
    }
    pendingBoundaryRef.current = { direction, targetPage };
    void onLoadHistoryPage(targetPage);
  }

  useLayoutEffect(() => {
    const wasLoading = historyLoadingRef.current;
    historyLoadingRef.current = historyLoading;
    const pending = pendingBoundaryRef.current;
    if (!pending) return;

    if (page === pending.targetPage) {
      if (historyLoading || !active || !open) return;
      pendingBoundaryRef.current = null;
      if (!focusCard(pending.direction)) setNavigationStatus("目标 SQLite 历史页没有可显示的记录。");
      return;
    }

    if (wasLoading && !historyLoading) {
      pendingBoundaryRef.current = null;
      setNavigationStatus("SQLite 历史页面读取失败，无法完成定位。");
    }
  }, [active, historyLoading, open, page, visibleRows]);

  return (
    <details
      ref={tableRef}
      className="sqlite-table"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {table.table}
        <span>{rows.length ? `${rows.length} 条` : table.reason ?? "没有关联记录"}</span>
      </summary>
      {open && table.reason && <p className="source-note">{table.reason}</p>}
      {open && table.table === "thread_items" && (
        <ConversationTypeFilter
          options={SQLITE_ITEM_TYPES}
          hiddenTypes={hiddenTypes}
          onChange={(next) => { setHiddenTypes(next); setNavigationStatus(""); }}
          visibleCount={visibleRows.length}
          totalCount={rows.length}
          note="筛选应用于每页历史项目；分页仍按全部记录。"
        />
      )}
      {open && rows.length > 0 && !visibleRows.length && <p className="source-note" role="status">当前页的记录已全部隐藏，请调整显示类型或继续翻页。</p>}
      {open && (
        <div className="sqlite-history-cards">
          {visibleRows.map(({ row, index }) => (
            <SqliteHistoryCard
              table={table.table}
              row={row}
              index={index}
              active={active}
              controlsVisible={visibleCardIndices.has(index)}
              onNavigateBoundary={navigateBoundary}
              key={`${table.table}-${row?.item_id ?? row?.turn_id ?? row?.goal_id ?? index}-${index}`}
            />
          ))}
        </div>
      )}
      {open && navigationStatus && <p className="source-note sqlite-navigation-status" role="status" aria-live="polite">{navigationStatus}</p>}
      {open && pagination && (
        <div className="history-pager">
          <span>第 {pagination.page} 页，共 {pagination.totalRows} 条</span>
          <button
            type="button"
            onClick={() => onLoadHistoryPage(pagination.page - 1)}
            disabled={historyLoading || pagination.page <= 1}
          >
            上一页
          </button>
          <button
            type="button"
            onClick={() => onLoadHistoryPage(pagination.page + 1)}
            disabled={historyLoading || !pagination.hasMore}
          >
            下一页
          </button>
        </div>
      )}
    </details>
  );
}

export function SqliteSupplement({ sources, active = true, historyLoading, onLoadHistoryPage }) {
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
                active={active}
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
