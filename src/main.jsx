import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createEmptySessionTabs, sessionTabsReducer } from "./lib/session-tabs.js";
import { createRoot } from "react-dom/client";
import { parseRolloutText } from "./lib/rollout.js";
import { groupSessionsByProject } from "./lib/projects.js";
import MarkdownContent from "./components/MarkdownContent.jsx";
import "./style.css";

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function SessionTabContent({ sessionId, refreshVersion }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`会话读取失败（${response.status}）`);
        return response.json();
      })
      .then((value) => {
        if (!ignore) {
          setDetail(value);
          setError("");
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!ignore) {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => { ignore = true; };
  }, [sessionId, refreshVersion]);

  async function loadHistoryPage(page) {
    if (!detail || page < 1) return;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?historyPage=${page}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`SQLite 历史读取失败（${response.status}）`);
      const value = await response.json();
      setDetail((current) => current ? { ...current, supplement: value.supplement } : current);
      setError("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  const timeline = useMemo(() => detail ? parseRolloutText(detail.contents) : [], [detail]);

  if (!detail) {
    if (error) return <div className="tab-state"><div className="error-banner" role="alert">{error}</div></div>;
    return <div className="tab-state" role="status">{loading ? "正在读取会话…" : "会话内容不可用"}</div>;
  }

  return <>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="session-header"><div><div className="eyebrow">{detail.archived ? "归档会话" : "活动会话"}<span>·</span>{detail.filename}</div><h1>{detail.title || detail.preview || "未命名会话"}</h1><p>{detail.cwd || "工作目录未知"}{detail.model ? ` · ${detail.model}` : ""}{detail.tokens_used != null ? ` · ${detail.tokens_used} tokens` : ""} <span>·</span> {formatDate(detail.updatedAt ?? detail.timestamp)}{detail.source ? ` · ${detail.source}` : ""}</p></div><div className="event-count"><strong>{timeline.length}</strong><small>条记录</small></div></div>
    <div className="timeline-label"><h2>运行记录</h2><span>按记录时间排列</span></div>
    <div className="timeline">{timeline.map((entry) => <article className={`event-card ${entry.kind}`} key={`${entry.lineNumber}-${entry.timestamp}`}>
      <div className="event-rail"><span className="event-marker" /></div><div className="event-body"><div className="event-meta"><span className="event-title">{entry.title}</span><time>{formatDate(entry.timestamp)}</time><span className="line-number">第 {entry.lineNumber} 行</span></div>
        {entry.markdown && entry.text && <MarkdownContent>{entry.text}</MarkdownContent>}
        {entry.contentParts?.map((part, index) => part.kind === "markdown"
          ? <MarkdownContent key={`${entry.lineNumber}-markdown-${index}`}>{part.text}</MarkdownContent>
          : <pre className="event-text tool-output-plain" key={`${entry.lineNumber}-plain-${index}`}>{part.text}</pre>)}
        {entry.text && !entry.markdown && !entry.contentParts && <pre className="event-text">{typeof entry.text === "string" ? entry.text : JSON.stringify(entry.text, null, 2)}</pre>}
        {entry.kind === "invalid" && <p className="warning">该行不是有效 JSON，原文仍保留在下方。</p>}
        <details><summary>原始 JSON</summary><pre>{entry.raw}</pre></details>
      </div>
    </article>)}</div>
    <section className="sqlite-section">
      <div className="timeline-label"><h2>SQLite 补充数据</h2><span>按会话 ID 关联 · 只读</span></div>
      <div className="sqlite-sources">{(detail.supplement ?? []).map((source) => <article className="sqlite-source" key={source.database}>
        <div className="sqlite-source-heading"><strong>{source.database}</strong><span className={source.available ? "source-ok" : "source-muted"}>{source.available ? "已读取" : "不可用"}</span></div>
        {source.error && <p className="source-note">{source.error}</p>}
        {source.tables?.map((table) => <details className="sqlite-table" key={table.table}>
          <summary>{table.table}<span>{table.rows?.length ? `${table.rows.length} 条` : table.reason ?? "没有关联记录"}</span></summary>
          {table.reason && <p className="source-note">{table.reason}</p>}
          {table.rows?.slice(0, 50).map((row, index) => <pre className="sqlite-row" key={`${table.table}-${index}`}>{JSON.stringify(row, null, 2).slice(0, 12_000)}{JSON.stringify(row, null, 2).length > 12_000 ? "… [row truncated]" : ""}</pre>)}
          {table.pagination && <div className="history-pager"><span>第 {table.pagination.page} 页，共 {table.pagination.totalRows} 条</span><button onClick={() => loadHistoryPage(table.pagination.page - 1)} disabled={historyLoading || table.pagination.page <= 1}>上一页</button><button onClick={() => loadHistoryPage(table.pagination.page + 1)} disabled={historyLoading || !table.pagination.hasMore}>下一页</button></div>}
        </details>)}
      </article>)}</div>
    </section>
  </>;
}

export function SessionViewer() {
  const [sessions, setSessions] = useState([]);
  const [tabState, dispatchTabs] = useReducer(sessionTabsReducer, undefined, createEmptySessionTabs);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const initialLoadStarted = useRef(false);

  function makeTabId() {
    return globalThis.crypto?.randomUUID?.()
      ?? `session-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function refresh(openFirst = false) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) throw new Error(`会话列表读取失败（${response.status}）`);
      const items = await response.json();
      setSessions(items);
      setRefreshVersion((version) => version + 1);
      if (openFirst && items[0]) {
        dispatchTabs({ type: "open", id: makeTabId(), sessionId: items[0].id });
      }
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    refresh(true);
  }, []);

  const projectGroups = useMemo(() => groupSessionsByProject(sessions, search), [sessions, search]);
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId);
  const activeSession = sessions.find((session) => session.id === activeTab?.sessionId);

  function openSession(sessionId) {
    dispatchTabs({ type: "open", id: makeTabId(), sessionId });
  }

  function closeTab(event, tabId) {
    event.stopPropagation();
    dispatchTabs({ type: "close", id: tabId });
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">C</span><div><strong>Codex</strong><small>运行轨迹查看器</small></div></div>
      <div className="side-heading"><span>会话</span><button className="icon-button" onClick={() => refresh()} aria-label="刷新会话" title="刷新会话">↻</button></div>
      <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目或会话" /></label>
      <div className="session-list">
        {projectGroups.map((group) => <section className="project-group" key={group.key}>
          <div className="project-heading" title={group.cwd || "项目未知"}><span className="project-heading-copy"><strong>{group.name}</strong><small>{group.cwd || "工作目录未知"}</small></span><span>{group.sessions.length}</span></div>
          {group.sessions.map((session) => <button key={session.id} className={`session-item ${activeTab?.sessionId === session.id ? "active" : ""}`} onClick={() => openSession(session.id)} aria-label={`在新标签页打开：${session.title || session.preview}`}>
            <span className={`session-icon ${session.archived ? "archived" : ""}`} aria-label={session.archived ? "已归档" : "活动会话"}>{session.archived ? "◷" : "◉"}</span><span className="session-copy"><strong>{session.title || session.preview}</strong><small>{session.model || "模型未知"}{session.tokens_used != null ? ` · ${session.tokens_used} tokens` : ""}</small><small>{formatDate(session.updatedAt ?? session.timestamp)} · {session.archived ? "已归档" : "活动"}{session.source ? ` · ${session.source}` : ""}</small></span>
          </button>)}
        </section>)}
        {!projectGroups.length && <p className="empty-list">{search ? "没有匹配的项目或会话" : "未发现会话记录"}</p>}
      </div>
      <div className="sidebar-footer"><span className="status-dot" />仅在本机读取</div>
    </aside>
    <section className="content">
      <header className="topbar"><div className="breadcrumb">本地数据 <span>/</span> {activeSession?.archived ? "归档会话" : "会话详情"}</div><div className="top-actions"><span className="local-badge"><span className="status-dot" />本地</span><button className="refresh-button" onClick={() => refresh()} disabled={loading}>{loading ? "刷新中…" : "↻　刷新"}</button></div></header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="session-tabs" role="tablist" aria-label="已打开的会话">
        {tabState.tabs.map((tab) => {
          const session = sessions.find((item) => item.id === tab.sessionId);
          const label = session?.title || session?.preview || tab.sessionId;
          const selected = tab.id === tabState.activeTabId;
          return <div className={`session-tab ${selected ? "active" : ""}`} key={tab.id}>
            <button id={`session-tab-${tab.id}`} className="session-tab-select" type="button" role="tab" aria-selected={selected} aria-controls={`session-panel-${tab.id}`} title={label} onClick={() => dispatchTabs({ type: "activate", id: tab.id })}>{label}</button>
            <button className="session-tab-close" type="button" aria-label={`关闭会话标签：${label}`} title="关闭标签" onClick={(event) => closeTab(event, tab.id)}>×</button>
          </div>;
        })}
      </div>
      <div className="session-tab-panels">
        {tabState.tabs.map((tab) => <section className="session-tab-panel" id={`session-panel-${tab.id}`} role="tabpanel" aria-labelledby={`session-tab-${tab.id}`} hidden={tab.id !== tabState.activeTabId} key={tab.id}>
          <SessionTabContent sessionId={tab.sessionId} refreshVersion={refreshVersion} />
        </section>)}
        {!tabState.tabs.length && <div className="welcome"><div className="welcome-symbol">⌘</div><h1>{sessions.length ? "选择一个会话" : "还没有发现会话"}</h1><p>{sessions.length ? "从左侧列表打开一段本地 Codex 运行轨迹。" : "确认 CODEX_HOME 指向包含 sessions 或 archived_sessions 的目录，然后刷新。"}</p></div>}
      </div>
    </section>
  </main>;
}

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement) createRoot(rootElement).render(<React.StrictMode><SessionViewer /></React.StrictMode>);
}
