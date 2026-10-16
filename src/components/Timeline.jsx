import MarkdownContent from "./MarkdownContent.jsx";
import { formatDate } from "../lib/formatters.js";

export function Timeline({ entries }) {
  return (
    <>
      <div className="timeline-label">
        <h2>运行记录</h2>
        <span>按记录时间排列</span>
      </div>
      <div className="timeline">
        {entries.map((entry) => (
          <article className={`event-card ${entry.kind}`} key={`${entry.lineNumber}-${entry.timestamp}`}>
            <div className="event-rail"><span className="event-marker" /></div>
            <div className="event-body">
              <div className="event-meta">
                <span className="event-title">{entry.title}</span>
                <time>{formatDate(entry.timestamp)}</time>
                <span className="line-number">第 {entry.lineNumber} 行</span>
              </div>
              {entry.markdown && entry.text && <MarkdownContent>{entry.text}</MarkdownContent>}
              {entry.contentParts?.map((part, index) => part.kind === "markdown"
                ? <MarkdownContent key={`${entry.lineNumber}-markdown-${index}`}>{part.text}</MarkdownContent>
                : <pre className="event-text tool-output-plain" key={`${entry.lineNumber}-plain-${index}`}>{part.text}</pre>)}
              {entry.text && !entry.markdown && !entry.contentParts && (
                <pre className="event-text">
                  {typeof entry.text === "string" ? entry.text : JSON.stringify(entry.text, null, 2)}
                </pre>
              )}
              {entry.kind === "invalid" && <p className="warning">该行不是有效 JSON，原文仍保留在下方。</p>}
              <details>
                <summary>原始 JSON</summary>
                <pre>{entry.raw}</pre>
              </details>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
