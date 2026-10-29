import { sessionDisplayTitle } from "../lib/session-identity.js";
import { SessionPanel } from "./SessionPanel.jsx";

export function SessionWorkspace({
  sessions,
  tabState,
  dispatchTabs,
  activeSession,
  activeTabId,
  refreshVersion,
  loading,
  error,
  onRefresh,
  onOpenSession,
  onRequestStart,
  onRequestSettled,
  onPanelClosed,
}) {
  function closeTab(event, tab) {
    event.stopPropagation();
    onPanelClosed?.(tab.id);
    dispatchTabs({ type: "close", id: tab.id });
  }

  return (
    <section className="content">
      <header className="topbar">
        <div className="breadcrumb">
          本地数据 <span>/</span> {activeSession?.archived ? "归档会话" : "会话详情"}
        </div>
        <div className="top-actions">
          <span className="local-badge"><span className="status-dot" />本地</span>
          <button className="refresh-button" onClick={onRefresh} disabled={loading}>
            {loading ? "刷新中…" : "↻　刷新"}
          </button>
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="session-tabs" role="tablist" aria-label="已打开的会话">
        {tabState.tabs.map((tab) => {
          const session = sessions.find((item) => item.id === tab.sessionId);
          const label = session ? sessionDisplayTitle(session, tab.sessionId) : tab.sessionId;
          const selected = tab.id === tabState.activeTabId;
          return (
            <div className={`session-tab ${selected ? "active" : ""}`} key={tab.id}>
              <button
                id={`session-tab-${tab.id}`}
                className="session-tab-select"
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`session-panel-${tab.id}`}
                title={label}
                onClick={() => dispatchTabs({ type: "activate", id: tab.id })}
              >
                {label}
              </button>
              <button
                className="session-tab-close"
                type="button"
                aria-label={`关闭会话标签：${label}`}
                title="关闭标签"
                onClick={(event) => closeTab(event, tab)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="session-tab-panels">
        {tabState.tabs.map((tab) => (
          <section
            className="session-tab-panel"
            id={`session-panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`session-tab-${tab.id}`}
            hidden={tab.id !== tabState.activeTabId}
            key={tab.id}
          >
            <SessionPanel
              sessionId={tab.sessionId}
              panelId={tab.id}
              refreshVersion={refreshVersion}
              active={tab.id === activeTabId}
              onRequestStart={onRequestStart}
              onRequestSettled={onRequestSettled}
              onOpenSession={onOpenSession}
            />
          </section>
        ))}
        {!tabState.tabs.length && (
          <div className="welcome">
            <div className="welcome-symbol">⌘</div>
            <h1>{sessions.length ? "选择一个会话" : "还没有发现会话"}</h1>
            <p>
              {sessions.length
                ? "从左侧列表打开一段本地 Codex 运行轨迹。"
                : "确认 CODEX_HOME 指向包含 sessions 或 archived_sessions 的目录，然后刷新。"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
