import { SessionSearch } from "./SessionSearch.jsx";

export function SessionSidebar({
  sessions,
  activeSessionId,
  onOpenSession,
  onRefresh,
  loading,
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">C</span>
        <div><strong>Codex</strong><small>运行轨迹查看器</small></div>
      </div>
      <SessionSearch
        sessions={sessions}
        activeSessionId={activeSessionId}
        onOpenSession={onOpenSession}
        onRefresh={onRefresh}
        loading={loading}
      />
      <div className="sidebar-footer"><span className="status-dot" />仅在本机读取</div>
    </aside>
  );
}
