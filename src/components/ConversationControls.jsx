export function ConversationControls({
  controlsVisible,
  controlsLabel,
  collapsed,
  collapsedActionLabel,
  expandedActionLabel,
  onCopy,
  onCancelCopy,
  copyPending,
  copyStatus,
  onToggleCollapse,
  onNavigateFirst,
  onNavigateLast,
}) {
  const tabIndex = controlsVisible ? 0 : -1;

  return (
    <nav
      className={`event-controls ${controlsVisible ? "is-visible" : ""}`}
      aria-label={controlsLabel}
      aria-hidden={!controlsVisible}
    >
      <button type="button" onClick={onCopy} aria-label="复制对话" title="复制对话" tabIndex={tabIndex}>复制对话</button>
      {copyPending && <button type="button" onClick={onCancelCopy} aria-label="取消复制" title="取消复制" tabIndex={tabIndex}>取消</button>}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? expandedActionLabel : collapsedActionLabel}
        title={collapsed ? "展开对象" : "收起对话"}
        tabIndex={tabIndex}
      >
        {collapsed ? "展开" : "收起对话"}
      </button>
      <button type="button" data-timeline-action="first" onClick={onNavigateFirst} aria-label="回到会话开始处" title="回到会话开始处" tabIndex={tabIndex}>↑</button>
      <button type="button" data-timeline-action="last" onClick={onNavigateLast} aria-label="跳转到会话末尾" title="跳转到会话末尾" tabIndex={tabIndex}>↓</button>
      <span className="event-copy-status" role="status" aria-live="polite">{copyStatus}</span>
    </nav>
  );
}
