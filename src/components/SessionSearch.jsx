import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatDate } from "../lib/formatters.js";
import { groupSessionsByProject } from "../lib/projects.js";
import { browserLogger, createLogId } from "../lib/logger.js";
import { normalizedAgentPath, sessionDisplayTitle, sessionKindLabel } from "../lib/session-identity.js";
import { useVirtualWindow } from "../hooks/useVirtualWindow.js";

const SIDEBAR_OVERSCAN_PX = 420;
const SIDEBAR_MAX_MOUNTED_ROWS = 100;
const SIDEBAR_ESTIMATED_ROW_HEIGHT = 82;

function flattenProjectGroups(projectGroups) {
  const rows = [];
  for (const group of projectGroups) {
    rows.push({ kind: "project", key: `project:${group.key}`, group });
    for (const session of group.sessions) {
      rows.push({ kind: "session", key: `session:${session.id}`, group, session });
    }
  }
  return rows;
}

export function SessionSearch({ sessions, activeSessionId, onOpenSession, onRefresh, loading }) {
  const [search, setSearch] = useState("");
  const projectGroups = useMemo(() => groupSessionsByProject(sessions, search), [sessions, search]);
  const previousSearchRef = useRef(search);
  const listRef = useRef(null);
  const rowRefCallbacks = useRef(new Map());
  const pendingFocusKey = useRef(null);
  const lastFocusedRef = useRef(null);
  const [focusVersion, setFocusVersion] = useState(0);
  const rows = useMemo(() => flattenProjectGroups(projectGroups), [projectGroups]);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const getScrollElement = useCallback(() => listRef.current, []);
  const getMetrics = useCallback((_list, scrollElement) => ({
    scrollTop: scrollElement.scrollTop,
    viewportHeight: scrollElement.clientHeight,
  }), []);
  const virtualWindow = useVirtualWindow({
    itemKeys: rowKeys,
    getScrollElement,
    getMetrics,
    estimatedHeight: SIDEBAR_ESTIMATED_ROW_HEIGHT,
    overscanPx: SIDEBAR_OVERSCAN_PX,
    maxItems: SIDEBAR_MAX_MOUNTED_ROWS,
  });
  const setListRef = useCallback((node) => {
    listRef.current = node;
    virtualWindow.listRef.current = node;
  }, [virtualWindow.listRef]);
  const getRowRef = useCallback((key) => {
    let callback = rowRefCallbacks.current.get(key);
    if (callback) return callback;
    callback = (node) => {
      virtualWindow.registerItem(key, node);
      if (!node) rowRefCallbacks.current.delete(key);
    };
    rowRefCallbacks.current.set(key, callback);
    return callback;
  }, [virtualWindow.registerItem]);

  useLayoutEffect(() => {
    virtualWindow.scrollToTop();
  }, [search]);

  useEffect(() => {
    if (previousSearchRef.current === search) return undefined;
    previousSearchRef.current = search;
    const resultCount = projectGroups.reduce((count, group) => count + group.sessions.length, 0);
    const operationId = createLogId();
    const timer = globalThis.setTimeout(() => {
      browserLogger.log("browser_filter", {
        data_source: "list",
        query_length: search.length,
        result_count: resultCount,
        hidden_count: Math.max(0, sessions.length - resultCount),
        operation_id: operationId,
      }, { operation_id: operationId });
    }, 300);
    return () => globalThis.clearTimeout(timer);
  }, [search]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const pendingKey = pendingFocusKey.current;
    if (pendingKey) {
      pendingFocusKey.current = null;
      const button = [...(list?.querySelectorAll(".session-item") ?? [])]
        .find((candidate) => candidate.dataset.sidebarKey === pendingKey);
      button?.focus();
      return;
    }

    if (globalThis.document?.activeElement !== globalThis.document?.body) return;
    const lastFocused = lastFocusedRef.current;
    if (!list || !lastFocused) return;
    const focusedKeyStillExistsAtIndex = rowKeys[lastFocused.index] === lastFocused.key;
    if (focusedKeyStillExistsAtIndex && lastFocused.index >= virtualWindow.range.start && lastFocused.index < virtualWindow.range.end) return;
    const nextButton = [...list.querySelectorAll(".session-item")][0];
    if (nextButton) {
      nextButton.focus();
      lastFocusedRef.current = {
        key: nextButton.dataset.sidebarKey,
        index: Number(nextButton.dataset.sidebarIndex),
      };
    } else {
      list.focus();
    }
  }, [focusVersion, rowKeys, virtualWindow.range.start, virtualWindow.range.end]);

  function nextSessionRow(startIndex, direction) {
    let index = startIndex;
    while (index >= 0 && index < rows.length) {
      if (rows[index].kind === "session") return index;
      index += direction;
    }
    return -1;
  }

  function handleListKeyDown(event) {
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const isHome = event.key === "Home";
    const isEnd = event.key === "End";
    if (!direction && !isHome && !isEnd) return;

    const button = event.target.closest(".session-item");
    let targetIndex = -1;
    if (isHome) targetIndex = nextSessionRow(0, 1);
    else if (isEnd) targetIndex = nextSessionRow(rows.length - 1, -1);
    else {
      const current = button ? Number(button.dataset.sidebarIndex) : -1;
      if (!button && activeSessionId) {
        const selectedIndex = rows.findIndex((row) => row.session?.id === activeSessionId);
        targetIndex = nextSessionRow(selectedIndex + direction, direction);
      } else if (!button) {
        targetIndex = nextSessionRow(direction > 0 ? 0 : rows.length - 1, direction);
      } else {
        targetIndex = nextSessionRow(current + direction, direction);
      }
    }
    if (targetIndex < 0) return;
    event.preventDefault();
    pendingFocusKey.current = rows[targetIndex].key;
    setFocusVersion((current) => current + 1);
    virtualWindow.scrollToIndex(targetIndex, "center");
  }

  function handleFocus(event) {
    const button = event.target.closest(".session-item");
    if (!button) return;
    lastFocusedRef.current = {
      key: button.dataset.sidebarKey,
      index: Number(button.dataset.sidebarIndex),
    };
  }

  const start = Math.min(virtualWindow.range.start, rows.length);
  const end = Math.min(virtualWindow.range.end, rows.length);
  const mountedRows = rows.slice(start, end);

  return (
    <>
      <div className="side-heading">
        <span>会话</span>
        <button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="刷新会话" title="刷新会话">↻</button>
      </div>
      <label className="search-box">
        <span>⌕</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索项目或会话"
        />
      </label>
      <div
        className="session-list"
        ref={setListRef}
        role="list"
        aria-label="项目和会话列表"
        aria-setsize={rows.length}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onFocusCapture={handleFocus}
      >
        <div className="sidebar-virtual-spacer" role="presentation" aria-hidden="true" style={{ height: virtualWindow.range.offsetTop }} />
        {mountedRows.map((row, offset) => {
              const index = start + offset;
              if (row.kind === "project") {
                const group = row.group;
                return (
                  <div
                    className="project-group-row project-group-heading-row"
                    key={row.key}
                    data-virtual-key={row.key}
                    data-virtual-index={index}
                    data-sidebar-index={index}
                    role="listitem"
                    aria-setsize={rows.length}
                    aria-posinset={index + 1}
                    ref={getRowRef(row.key)}
                  >
                    <div className="project-heading" title={group.cwd || "项目未知"}>
                      <span className="project-heading-copy">
                        <strong>{group.name}</strong>
                        <small>{group.cwd || "工作目录未知"}</small>
                      </span>
                      <span>{group.sessions.length}</span>
                    </div>
                  </div>
                );
              }

              const { session } = row;
              return (
                <div
                  className={`project-group-row project-group-session ${row.group.sessions.at(-1)?.id === session.id ? "project-group-last-session" : ""}`}
                  key={row.key}
                  data-virtual-key={row.key}
                  data-virtual-index={index}
                  role="listitem"
                  aria-setsize={rows.length}
                  aria-posinset={index + 1}
                  ref={getRowRef(row.key)}
                >
                  <button
                    data-sidebar-key={row.key}
                    data-sidebar-index={index}
                    className={`session-item ${activeSessionId === session.id ? "active" : ""}`}
                    onClick={() => onOpenSession(session.id)}
                    aria-current={activeSessionId === session.id ? "page" : undefined}
                    aria-label={`打开会话：${sessionDisplayTitle(session)}${session.guardian ? "，Guardian会话" : session.agent ? `，子代理会话，父会话：${session.agent.parentTitle || session.agent.parentThreadId || "未知"}` : ""}`}
                  >
                    <span
                      className={`session-icon ${session.archived ? "archived" : ""}`}
                      aria-label={session.archived ? "已归档" : "活动会话"}
                    >
                      {session.archived ? "◷" : "◉"}
                    </span>
                    <span className="session-copy">
                      <strong>{sessionDisplayTitle(session)}</strong>
                      {(session.agent || session.guardian) && (
                        <span className={`session-agent-badge ${session.agent?.conflict ? "conflict" : ""}`}>
                          {sessionKindLabel(session)}
                        </span>
                      )}
                      <small>
                        {session.agent?.conflict
                          ? "父会话关联冲突"
                          : session.guardian
                            ? "Guardian会话"
                            : session.agent
                              ? `父会话：${session.agent.parentTitle || session.agent.parentThreadId || "未知"}`
                              : "主会话"}
                      </small>
                      <small>
                        {normalizedAgentPath(session) || session.model || "模型未知"}
                        {session.agent?.role ? ` · ${session.agent.role}` : ""}
                        {session.tokens_used != null ? ` · ${session.tokens_used} tokens` : ""}
                      </small>
                      <small>
                        {formatDate(session.updatedAt ?? session.timestamp)} · {session.archived ? "已归档" : "活动"}
                        {session.source ? ` · ${session.source}` : ""}
                      </small>
                    </span>
                  </button>
                </div>
              );
        })}
        <div className="sidebar-virtual-spacer" role="presentation" aria-hidden="true" style={{ height: virtualWindow.range.offsetBottom }} />
        {!projectGroups.length && (
          <p className="empty-list">{search ? "没有匹配的项目或会话" : "未发现会话记录"}</p>
        )}
      </div>
    </>
  );
}
