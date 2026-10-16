import { agentStatusLabel, formatDate } from "../lib/formatters.js";
import { sessionDisplayTitle } from "../lib/session-identity.js";
import { SqliteSupplement } from "./SqliteSupplement.jsx";
import { Timeline } from "./Timeline.jsx";

export function SessionDetail({ detail, timeline, historyLoading, onLoadHistoryPage, onOpenSession }) {
  return (
    <>
      <div className="session-header">
        <div>
          <div className="eyebrow">
            {detail.archived ? "归档会话" : "活动会话"}<span>·</span>{detail.filename}
          </div>
          <h1>{sessionDisplayTitle(detail, "未命名会话")}</h1>
          <p>
            {detail.cwd || "工作目录未知"}
            {detail.model ? ` · ${detail.model}` : ""}
            {detail.tokens_used != null ? ` · ${detail.tokens_used} tokens` : ""}
            {" "}<span>·</span>{" "}
            {formatDate(detail.updatedAt ?? detail.timestamp)}
            {detail.source ? ` · ${detail.source}` : ""}
          </p>
        </div>
        <div className="event-count"><strong>{timeline.length}</strong><small>条记录</small></div>
      </div>

      {detail.agent && (
        <div className="agent-context">
          <span>子代理执行记录</span>
          <strong>{sessionDisplayTitle(detail, detail.sessionId)}</strong>
          {detail.agent.nickname && detail.agent.agentPath && <small>{detail.agent.nickname}</small>}
          {detail.agent.role && <small>角色：{detail.agent.role}</small>}
        </div>
      )}

      {!!detail.subagents?.length && (
        <section className="subagent-section" aria-label="子代理执行记录">
          <div className="timeline-label">
            <h2>子代理执行记录</h2>
            <span>{detail.subagents.length} 个关联子代理</span>
          </div>
          <div className="subagent-list">
            {detail.subagents.map((child) => {
              const label = sessionDisplayTitle(child, child.threadId);
              return (
                <article
                  className={`subagent-card ${child.available ? "" : "unavailable"}`}
                  key={child.threadId}
                >
                  <div className="subagent-copy">
                    <strong>{label}</strong>
                    <small>
                      {child.agent?.role ? `角色：${child.agent.role} · ` : ""}
                      {agentStatusLabel(child.activityStatus)}
                      {child.archived ? " · 已归档" : ""}
                    </small>
                    {child.reason && <p>{child.reason}</p>}
                  </div>
                  {child.available && child.id
                    ? (
                      <button
                        type="button"
                        onClick={() => onOpenSession(child.id)}
                        aria-label={`打开子代理轨迹：${label}`}
                      >
                        查看完整轨迹
                      </button>
                    )
                    : <span className="subagent-unavailable">记录不可用</span>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <Timeline entries={timeline} />
      <SqliteSupplement
        sources={detail.supplement}
        historyLoading={historyLoading}
        onLoadHistoryPage={onLoadHistoryPage}
      />
    </>
  );
}
