import { formatDate } from "../lib/formatters.js";
import {
  normalizedAgentPath,
  sessionDisplayTitle,
  sessionKindLabel,
} from "../lib/session-identity.js";

export function SessionSidebar({
  projectGroups,
  search,
  onSearchChange,
  activeSessionId,
  onOpenSession,
  onRefresh,
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">C</span>
        <div><strong>Codex</strong><small>运行轨迹查看器</small></div>
      </div>
      <div className="side-heading">
        <span>会话</span>
        <button className="icon-button" onClick={onRefresh} aria-label="刷新会话" title="刷新会话">↻</button>
      </div>
      <label className="search-box">
        <span>⌕</span>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索项目或会话"
        />
      </label>
      <div className="session-list">
        {projectGroups.map((group) => (
          <section className="project-group" key={group.key}>
            <div className="project-heading" title={group.cwd || "项目未知"}>
              <span className="project-heading-copy">
                <strong>{group.name}</strong>
                <small>{group.cwd || "工作目录未知"}</small>
              </span>
              <span>{group.sessions.length}</span>
            </div>
            {group.sessions.map((session) => (
              <button
                key={session.id}
                className={`session-item ${activeSessionId === session.id ? "active" : ""}`}
                onClick={() => onOpenSession(session.id)}
                aria-label={`在新标签页打开：${sessionDisplayTitle(session)}${session.guardian ? "，Guardian会话" : session.agent ? `，子代理会话，父会话：${session.agent.parentTitle || session.agent.parentThreadId || "未知"}` : ""}`}
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
            ))}
          </section>
        ))}
        {!projectGroups.length && (
          <p className="empty-list">{search ? "没有匹配的项目或会话" : "未发现会话记录"}</p>
        )}
      </div>
      <div className="sidebar-footer"><span className="status-dot" />仅在本机读取</div>
    </aside>
  );
}
