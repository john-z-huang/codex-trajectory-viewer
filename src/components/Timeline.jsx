import { useEffect, useLayoutEffect, useRef, useState } from "react";
import MarkdownContent from "./MarkdownContent.jsx";
import { formatDate } from "../lib/formatters.js";

function renderedText(node) {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  if (node.tagName === "BR") return "\n";

  const content = [...node.childNodes].map(renderedText).join("");
  const isBlock = /^(ADDRESS|ARTICLE|BLOCKQUOTE|DIV|H[1-6]|LI|OL|P|PRE|SECTION|UL)$/.test(node.tagName);
  return isBlock && content && !content.endsWith("\n") ? `${content}\n` : content;
}

export function Timeline({ entries }) {
  const [collapsedEntries, setCollapsedEntries] = useState({});
  const [visibleEntryIds, setVisibleEntryIds] = useState(() => new Set());
  const [copyStatuses, setCopyStatuses] = useState({});
  const [highlightedEntries, setHighlightedEntries] = useState({});
  const timelineRef = useRef(null);
  const pendingCenterEntryId = useRef(null);
  const highlightTimers = useRef(new Map());

  useEffect(() => () => {
    for (const timer of highlightTimers.current.values()) clearTimeout(timer);
    highlightTimers.current.clear();
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    const panel = timeline?.closest(".session-tab-panel");
    const Observer = globalThis.IntersectionObserver;
    if (!timeline || !panel || !Observer) return undefined;

    const observer = new Observer((observations) => {
      setVisibleEntryIds((current) => {
        let next = current;
        for (const observation of observations) {
          const entryId = observation.target.dataset.eventKey;
          const visible = observation.isIntersecting && observation.intersectionRatio > 0;
          if (visible === current.has(entryId)) continue;
          if (next === current) next = new Set(current);
          if (visible) next.add(entryId);
          else next.delete(entryId);
        }
        return next;
      });
    }, { root: panel, threshold: 0 });

    timeline.querySelectorAll(".event-card").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [entries]);

  useLayoutEffect(() => {
    const entryId = pendingCenterEntryId.current;
    if (!entryId) return;
    pendingCenterEntryId.current = null;

    const card = [...(timelineRef.current?.querySelectorAll(".event-card") ?? [])]
      .find((candidate) => candidate.dataset.eventKey === entryId);
    const panel = card?.closest(".session-tab-panel");
    if (!card || !panel) return;

    const panelRect = panel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportHeight = panel.clientHeight || panelRect.height;
    const targetTop = panel.scrollTop + cardRect.top - panelRect.top - (viewportHeight - cardRect.height) / 2;
    const maxScrollTop = Math.max(0, panel.scrollHeight - viewportHeight);
    panel.scrollTo({
      top: Math.max(0, Math.min(targetTop, maxScrollTop)),
      behavior: "smooth",
    });
  }, [collapsedEntries]);

  function scrollToEntry(event, edge) {
    const panel = event.currentTarget.closest(".session-tab-panel");
    const target = panel?.querySelector(
      edge === "first" ? ".timeline .event-card:first-child" : ".timeline .event-card:last-child",
    );
    if (!panel || !target) return;
    const panelRect = panel.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    panel.scrollTo({
      top: panel.scrollTop + targetRect.top - panelRect.top,
      behavior: "smooth",
    });
  }

  async function copyEntryContent(event, entryId) {
    const card = event.currentTarget.closest(".event-card");
    const content = card?.querySelector(".event-content");
    const text = renderedText(content).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      setCopyStatuses((current) => ({ ...current, [entryId]: "没有可复制内容" }));
      return;
    }

    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await clipboard.writeText(text);
      setCopyStatuses((current) => ({ ...current, [entryId]: "已复制" }));
    } catch {
      setCopyStatuses((current) => ({ ...current, [entryId]: "复制失败" }));
    }
  }

  return (
    <>
      <div className="timeline-label">
        <h2>运行记录</h2>
        <span>按记录时间排列</span>
      </div>
      <div className="timeline" ref={timelineRef}>
        {entries.map((entry) => {
          const entryId = `${entry.lineNumber}-${entry.timestamp}`;
          const collapsed = Boolean(collapsedEntries[entryId]);
          const controlsVisible = visibleEntryIds.has(entryId);
          return (
            <article className={`event-card ${entry.kind}`} key={entryId} data-event-key={entryId}>
              <div className="event-rail"><span className="event-marker" /></div>
              <div className={`event-body ${collapsed ? "collapsed" : ""} ${highlightedEntries[entryId] ? "collapse-highlight" : ""}`}>
                <div className="event-meta">
                  <span className="event-title">{entry.title}</span>
                  <time>{formatDate(entry.timestamp)}</time>
                  <span className="line-number">第 {entry.lineNumber} 行</span>
                </div>
                <nav
                  className={`event-controls ${controlsVisible ? "is-visible" : ""}`}
                  aria-label={`第 ${entry.lineNumber} 行 JSONL 对象操作`}
                  aria-hidden={!controlsVisible}
                >
                  <button
                    type="button"
                    onClick={(event) => copyEntryContent(event, entryId)}
                    aria-label="复制对话"
                    title="复制对话"
                    tabIndex={controlsVisible ? 0 : -1}
                  >复制对话</button>
                  <button
                    type="button"
                    onClick={() => {
                      if (collapsed) {
                        pendingCenterEntryId.current = null;
                      } else {
                        const card = [...(timelineRef.current?.querySelectorAll(".event-card") ?? [])]
                          .find((candidate) => candidate.dataset.eventKey === entryId);
                        const panel = card?.closest(".session-tab-panel");
                        const meta = card?.querySelector(".event-meta");
                        const panelRect = panel?.getBoundingClientRect();
                        const metaRect = meta?.getBoundingClientRect();
                        const panelHeight = panel?.clientHeight || panelRect?.height || 0;
                        const metaVisible = panelRect && metaRect
                          && metaRect.bottom > panelRect.top
                          && metaRect.top < panelRect.top + panelHeight;
                        pendingCenterEntryId.current = metaVisible ? null : entryId;
                        const previousTimer = highlightTimers.current.get(entryId);
                        if (previousTimer) clearTimeout(previousTimer);
                        setHighlightedEntries((current) => ({ ...current, [entryId]: true }));
                        const timer = setTimeout(() => {
                          highlightTimers.current.delete(entryId);
                          setHighlightedEntries((current) => ({ ...current, [entryId]: false }));
                        }, 3000);
                        highlightTimers.current.set(entryId, timer);
                      }
                      setCollapsedEntries((current) => ({ ...current, [entryId]: !collapsed }));
                    }}
                    aria-label={collapsed ? `展开第 ${entry.lineNumber} 行 JSONL 对象` : `收起第 ${entry.lineNumber} 行 JSONL 对象`}
                    title={collapsed ? "展开对象" : "收起对象"}
                    tabIndex={controlsVisible ? 0 : -1}
                  >
                    {collapsed ? "展开" : "收起对话"}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => scrollToEntry(event, "first")}
                    aria-label="回到会话开始处"
                    title="回到会话开始处"
                    tabIndex={controlsVisible ? 0 : -1}
                  >↑</button>
                  <button
                    type="button"
                    onClick={(event) => scrollToEntry(event, "last")}
                    aria-label="跳转到会话末尾"
                    title="跳转到会话末尾"
                    tabIndex={controlsVisible ? 0 : -1}
                  >↓</button>
                  <span className="event-copy-status" role="status" aria-live="polite">
                    {copyStatuses[entryId] ?? ""}
                  </span>
                </nav>
                <div className="event-content">
                  {entry.markdown && entry.text && <MarkdownContent>{entry.text}</MarkdownContent>}
                  {entry.contentParts?.map((part, index) => part.kind === "markdown"
                    ? <MarkdownContent key={`${entry.lineNumber}-markdown-${index}`}>{part.text}</MarkdownContent>
                    : <pre className="event-text tool-output-plain" key={`${entry.lineNumber}-plain-${index}`}>{part.text}</pre>)}
                  {entry.text && !entry.markdown && !entry.contentParts && (
                    <pre className="event-text">
                      {typeof entry.text === "string" ? entry.text : JSON.stringify(entry.text, null, 2)}
                    </pre>
                  )}
                </div>
                {!collapsed && <>
                  {entry.kind === "invalid" && <p className="warning">该行不是有效 JSON，原文仍保留在下方。</p>}
                  <details>
                    <summary>原始 JSON</summary>
                    <pre>{entry.raw}</pre>
                  </details>
                </>}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
