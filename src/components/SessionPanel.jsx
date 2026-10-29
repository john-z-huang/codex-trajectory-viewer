import { useSessionDetail } from "../hooks/useSessionDetail.js";
import { SessionDetail } from "./SessionDetail.jsx";

export function SessionPanel({
  sessionId,
  panelId = sessionId,
  refreshVersion,
  active = false,
  onRequestStart,
  onRequestSettled,
  onOpenSession,
}) {
  const {
    detail,
    rollout,
    entries,
    currentLine,
    loading,
    pageLoading,
    searchLoading,
    error,
    historyLoading,
    historySearchLoading,
    loadLine,
    searchNext,
    loadHistoryPage,
    searchHistory,
    recoverStaleRevision,
    retry,
  } = useSessionDetail(sessionId, refreshVersion, {
    panelId,
    active,
    onRequestStart,
    onRequestSettled,
  });

  if (!detail) {
    if (error) {
      return (
        <div className="tab-state">
          <div className="error-banner" role="alert">
            {error}<button type="button" onClick={retry}>刷新</button>
          </div>
        </div>
      );
    }
    return <div className="tab-state" role="status">{loading ? "正在读取会话…" : "会话内容不可用"}</div>;
  }

  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}<button type="button" onClick={retry}>重试</button>
        </div>
      )}
      <SessionDetail
        detail={detail}
        timeline={entries}
        rollout={rollout}
        currentLine={currentLine}
        pageLoading={pageLoading}
        searchLoading={searchLoading}
        active={active}
        historyLoading={historyLoading}
        historySearchLoading={historySearchLoading}
        onNavigateLine={loadLine}
        onSearch={searchNext}
        onRevisionStale={recoverStaleRevision}
        onLoadHistoryPage={loadHistoryPage}
        onSearchHistory={searchHistory}
        onOpenSession={onOpenSession}
      />
    </>
  );
}
