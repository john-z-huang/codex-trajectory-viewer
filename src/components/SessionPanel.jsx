import { useMemo } from "react";
import { parseRolloutText } from "../lib/rollout.js";
import { useSessionDetail } from "../hooks/useSessionDetail.js";
import { SessionDetail } from "./SessionDetail.jsx";

export function SessionPanel({ sessionId, refreshVersion, onOpenSession }) {
  const { detail, loading, error, historyLoading, loadHistoryPage } = useSessionDetail(sessionId, refreshVersion);
  const timeline = useMemo(() => detail ? parseRolloutText(detail.contents) : [], [detail?.contents]);

  if (!detail) {
    if (error) return <div className="tab-state"><div className="error-banner" role="alert">{error}</div></div>;
    return <div className="tab-state" role="status">{loading ? "正在读取会话…" : "会话内容不可用"}</div>;
  }

  return (
    <>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <SessionDetail
        detail={detail}
        timeline={timeline}
        historyLoading={historyLoading}
        onLoadHistoryPage={loadHistoryPage}
        onOpenSession={onOpenSession}
      />
    </>
  );
}
