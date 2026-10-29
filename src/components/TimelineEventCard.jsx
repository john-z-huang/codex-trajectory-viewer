import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate } from "../lib/formatters.js";
import { parseRolloutText } from "../lib/rollout.js";
import { enqueueSessionView, sessionViewUrl, SessionViewError, STALE_SESSION_RESPONSE } from "../lib/session-view-requests.js";
import { getTextFragment, getTextFragmentCount, isLongText } from "../lib/text-fragments.js";
import MarkdownContent from "./MarkdownContent.jsx";

const MAX_VISIBLE_CONTENT_PARTS = 32;
const MAX_VISIBLE_CONTENT_CHARS = 16 * 1024;
function renderedText(element) {
  return element?.innerText ?? element?.textContent ?? "";
}

function partCount(entry) {
  return entry.contentParts?.length || (entry.text == null || entry.text === "" ? 0 : 1);
}

function partAt(entry, index) {
  if (entry.contentParts?.length) {
    const part = entry.contentParts[index];
    if (!part) return null;
    return {
      key: `part-${index}`,
      text: typeof part.text === "string" ? part.text : String(part.text ?? ""),
      markdown: part.kind === "markdown",
    };
  }
  if (index !== 0 || entry.text == null || entry.text === "") return null;
  return {
    key: "text",
    text: typeof entry.text === "string" ? entry.text : JSON.stringify(entry.text, null, 2),
    markdown: Boolean(entry.markdown),
  };
}

function contentSummary(entry) {
  let visibleParts = 0;
  let characters = 0;
  let pageCount = 0;
  let hasMarkdown = false;
  const count = partCount(entry);
  for (let index = 0; index < count; index += 1) {
    const part = partAt(entry, index);
    if (!part?.text) continue;
    if (visibleParts) characters += 1; // Keep a separator between separate tool content items.
    visibleParts += 1;
    characters += part.text.length;
    pageCount += getTextFragmentCount(part.text);
    hasMarkdown ||= part.markdown;
  }
  return {
    visibleParts,
    characters,
    pageCount: Math.max(1, pageCount),
    hasMarkdown,
    paged: characters > MAX_VISIBLE_CONTENT_CHARS || visibleParts > MAX_VISIBLE_CONTENT_PARTS,
  };
}

function normalizedCursor(entry, cursor) {
  const count = partCount(entry);
  let index = Math.max(0, Math.min(count - 1, Number.isInteger(cursor?.partIndex) ? cursor.partIndex : 0));
  while (index < count) {
    const part = partAt(entry, index);
    if (part?.text) {
      const fragments = getTextFragmentCount(part.text);
      const fragmentIndex = Math.max(0, Math.min(fragments - 1, Number.isInteger(cursor?.fragmentIndex) ? cursor.fragmentIndex : 0));
      return { pageIndex: Math.max(0, Number.isInteger(cursor?.pageIndex) ? cursor.pageIndex : 0), partIndex: index, fragmentIndex, part };
    }
    index += 1;
  }
  return { pageIndex: 0, partIndex: 0, fragmentIndex: 0, part: null };
}

function moveContentCursor(entry, cursor, direction) {
  const current = normalizedCursor(entry, cursor);
  if (!current.part) return current;
  const partFragments = getTextFragmentCount(current.part.text);
  if (direction > 0) {
    if (current.fragmentIndex + 1 < partFragments) {
      return { pageIndex: current.pageIndex + 1, partIndex: current.partIndex, fragmentIndex: current.fragmentIndex + 1 };
    }
    for (let index = current.partIndex + 1; index < partCount(entry); index += 1) {
      const part = partAt(entry, index);
      if (part?.text) return { pageIndex: current.pageIndex + 1, partIndex: index, fragmentIndex: 0 };
    }
    return current;
  }
  if (current.fragmentIndex > 0) {
    return { pageIndex: Math.max(0, current.pageIndex - 1), partIndex: current.partIndex, fragmentIndex: current.fragmentIndex - 1 };
  }
  for (let index = current.partIndex - 1; index >= 0; index -= 1) {
    const part = partAt(entry, index);
    if (part?.text) {
      return {
        pageIndex: Math.max(0, current.pageIndex - 1),
        partIndex: index,
        fragmentIndex: getTextFragmentCount(part.text) - 1,
      };
    }
  }
  return current;
}

function FragmentControls({ label, index, count, onPrevious, onNext }) {
  if (count < 2) return null;
  return (
    <nav className="event-fragment-controls" aria-label={label}>
      <span>第 {index + 1} / {count} 段</span>
      <button type="button" onClick={onPrevious} disabled={index <= 0} aria-label="查看上一段">上一段</button>
      <button type="button" onClick={onNext} disabled={index >= count - 1} aria-label="查看下一段">下一段</button>
    </nav>
  );
}

function EventContent({ entry, entryId, summary, cursor, onBodyCursorChange, full = false }) {
  if (!summary.visibleParts) return null;

  if (summary.paged && !full) {
    const current = normalizedCursor(entry, cursor);
    const page = current.part
      ? getTextFragment(current.part.text, current.fragmentIndex)
      : "";
    return (
      <div className="event-content">
        {summary.hasMarkdown && <small className="event-fragment-note">长记录按纯文本分段显示；每段最多 {MAX_VISIBLE_CONTENT_CHARS} 个 UTF-16 代码单元（代理对边界可多 1 个），复制对话会处理完整 Markdown。</small>}
        <pre className="event-text event-text-fragment">{page}</pre>
        <FragmentControls
          label={`第 ${entry.lineNumber} 条记录内容分段`}
          index={current.pageIndex}
          count={summary.pageCount}
          onPrevious={() => onBodyCursorChange(entryId, moveContentCursor(entry, current, -1))}
          onNext={() => onBodyCursorChange(entryId, moveContentCursor(entry, current, 1))}
        />
      </div>
    );
  }

  const count = partCount(entry);
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const part = partAt(entry, index);
    if (!part?.text) continue;
    blocks.push(
      <div className="event-content-block" key={part.key}>
        {part.markdown
          ? <MarkdownContent>{part.text}</MarkdownContent>
          : <pre className="event-text tool-output-plain">{part.text}</pre>}
      </div>,
    );
  }
  return <div className="event-content">{blocks}</div>;
}

function copyableEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const result = {
    lineNumber: entry.lineNumber,
    timestamp: entry.timestamp ?? null,
    kind: typeof entry.kind === "string" ? entry.kind : "event",
    title: typeof entry.title === "string" ? entry.title : "记录",
  };
  if (typeof entry.text === "string") result.text = entry.text;
  if (typeof entry.markdown === "boolean") result.markdown = entry.markdown;
  if (Array.isArray(entry.contentParts)) {
    result.contentParts = entry.contentParts
      .filter((part) => part && typeof part.text === "string")
      .map((part) => ({ ...(typeof part.kind === "string" ? { kind: part.kind } : {}), text: part.text }));
  }
  return result;
}

function isStaleRevision(error) {
  return error instanceof SessionViewError && (error.status === 409 || error.code === "stale_revision");
}

function RawContent({ entry, sessionId, offset, offsetHistory, onOffsetChange, onRevisionStale, active = true }) {
  const [chunk, setChunk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [manualOffset, setManualOffset] = useState(String(offset));
  const requestRef = useRef(null);
  const locator = entry.originalLocator;
  const rawOffsetInputId = `raw-offset-${useId()}`;

  useEffect(() => {
    setManualOffset(String(offset));
    setChunk(null);
    setLoading(true);
    setError("");
    const controller = new AbortController();
    const token = Symbol("raw chunk");
    const isCurrent = () => !controller.signal.aborted && requestRef.current?.token === token;
    const task = enqueueSessionView(sessionId, {
      view: "raw",
      revision: locator?.revision,
      line: entry.lineNumber,
      offset,
    }, {
      signal: controller.signal,
      priority: active ? 1 : 0,
      isCurrent,
    });
    requestRef.current = { controller, task, token };
    task.promise
      .then((value) => {
        if (isCurrent() && value !== STALE_SESSION_RESPONSE) setChunk(value);
      })
      .catch((reason) => {
        if (!isCurrent() || reason?.name === "AbortError") return;
        if (isStaleRevision(reason)) {
          setError("轨迹版本已变化；当前页正在恢复，请重新打开原文。");
          void onRevisionStale?.(entry.lineNumber, locator?.revision);
        } else if (reason?.status === 416) {
          setError(`${reason.message} 可返回原文起点后重试。`);
        } else {
          setError(reason?.message || "原文读取失败");
        }
      })
      .finally(() => {
        if (!isCurrent()) return;
        requestRef.current = null;
        setLoading(false);
      });
    return () => {
      if (requestRef.current?.token === token) requestRef.current = null;
      controller.abort();
      task.cancel();
    };
  }, [entry.lineNumber, locator?.revision, offset, onRevisionStale, sessionId]);

  useLayoutEffect(() => {
    requestRef.current?.task?.setPriority(active ? 1 : 0);
  }, [active]);

  function submitOffset(event) {
    event.preventDefault();
    const nextOffset = Number(manualOffset);
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > (chunk?.byteLength ?? 0)) {
      setError("请输入当前原文行范围内的非负字节偏移。");
      return;
    }
    setError("");
    onOffsetChange(entry.lineNumber, nextOffset, "push");
  }

  function goPrevious() {
    if (!offsetHistory.length) return;
    onOffsetChange(entry.lineNumber, offsetHistory.at(-1), "back");
  }

  if (!locator?.revision || !sessionId) return <p className="warning">缺少原文定位信息。</p>;
  return (
    <div className="event-raw-view">
      <div className="event-raw-toolbar">
        <span>{chunk ? `${chunk.offset}–${chunk.nextOffset} / ${chunk.byteLength} 字节` : "原始 JSON 分段"}</span>
        <form className="event-raw-offset" onSubmit={submitOffset}>
          <label htmlFor={rawOffsetInputId}>字节偏移</label>
          <input id={rawOffsetInputId} type="number" min="0" max={chunk?.byteLength ?? 0} value={manualOffset} onChange={(event) => setManualOffset(event.target.value)} />
          <button type="submit" disabled={loading}>跳转</button>
        </form>
        <button type="button" onClick={goPrevious} disabled={loading || offsetHistory.length === 0}>上一片</button>
        <button type="button" onClick={() => chunk && !chunk.done && onOffsetChange(entry.lineNumber, chunk.nextOffset, "push")} disabled={loading || !chunk || chunk.done}>下一片</button>
        <span className="event-raw-download-note">轨迹版本变化时，请刷新后重试。</span>
        <a
          href={sessionViewUrl(sessionId, { view: "download", revision: locator.revision, line: entry.lineNumber })}
          download={`rollout-line-${entry.lineNumber}.txt`}
        >
          下载完整原文
        </a>
      </div>
      {loading && <p role="status">正在读取原文片段…</p>}
      {error && <p className="warning" role="alert">{error}</p>}
      {chunk && <pre>{chunk.raw}</pre>}
    </div>
  );
}

export const TimelineEventCard = memo(function TimelineEventCard({
  entry,
  entryId,
  readingKey,
  entryIndex,
  lineIndex,
  totalEntries,
  sessionId,
  active = true,
  isLast = false,
  collapsed,
  rawExpanded,
  bodyCursor,
  rawOffset = 0,
  rawOffsetHistory = [],
  controlsVisible,
  registerItem,
  onToggleCollapse,
  onRawExpandedChange,
  onBodyCursorChange,
  onRawOffsetChange,
  onScrollToEntry,
  onRevisionStale,
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [highlighted, setHighlighted] = useState(false);
  const [copySourceEntry, setCopySourceEntry] = useState(null);
  const copyPending = useRef(false);
  const copyControllerRef = useRef(null);
  const copyTaskRef = useRef(null);
  const copySequenceRef = useRef(0);
  const highlightTimer = useRef(null);
  const bodyRef = useRef(null);
  const copySourceRef = useRef(null);
  const summary = useMemo(() => contentSummary(entry), [entry]);
  const copySummary = useMemo(() => copySourceEntry ? contentSummary(copySourceEntry) : null, [copySourceEntry]);
  const safeCursor = normalizedCursor(entry, bodyCursor);
  const virtualRef = useCallback((node) => registerItem(entryId, node), [entryId, registerItem]);
  const handleBodyCursorChange = useCallback((_entryId, cursor) => {
    onBodyCursorChange(readingKey, cursor);
  }, [onBodyCursorChange, readingKey]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    copySequenceRef.current += 1;
    copyControllerRef.current?.abort();
    copyTaskRef.current?.cancel();
    copyControllerRef.current = null;
    copyTaskRef.current = null;
    copyPending.current = false;
  }, []);

  useLayoutEffect(() => {
    copyTaskRef.current?.setPriority(active ? 1 : 0);
  }, [active]);

  async function writeCopy(text) {
    const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized) {
      setCopyStatus("没有可复制内容");
      copyPending.current = false;
      return;
    }
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await clipboard.writeText(normalized);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败");
    } finally {
      copyPending.current = false;
    }
  }

  useLayoutEffect(() => {
    if (!copySourceEntry) return;
    const text = renderedText(copySourceRef.current?.querySelector(".event-content"));
    setCopySourceEntry(null);
    void writeCopy(text);
  }, [copySourceEntry]);

  function cancelCopy() {
    copySequenceRef.current += 1;
    copyControllerRef.current?.abort();
    copyTaskRef.current?.cancel();
    copyControllerRef.current = null;
    copyTaskRef.current = null;
    setCopySourceEntry(null);
    copyPending.current = false;
    setCopyStatus("已取消复制");
  }

  function copyEntryContent() {
    if (copyPending.current) return;
    copyPending.current = true;
    setCopyStatus("");
    if (entry.kind !== "oversized" && !entry.projectionLimited) {
      const source = copyableEntry(entry);
      if (!source) {
        copyPending.current = false;
        setCopyStatus("没有可复制内容");
        return;
      }
      setCopySourceEntry(source);
      return;
    }

    const locator = entry.originalLocator;
    if (!locator?.revision || !sessionId) {
      copyPending.current = false;
      setCopyStatus("缺少原文定位信息");
      return;
    }
    const controller = new AbortController();
    const token = ++copySequenceRef.current;
    const isCurrent = () => !controller.signal.aborted && copySequenceRef.current === token;
    const task = enqueueSessionView(sessionId, {
      view: "download",
      revision: locator.revision,
      line: entry.lineNumber,
    }, {
      signal: controller.signal,
      priority: active ? 1 : 0,
      responseType: "text",
      isCurrent,
    });
    copyControllerRef.current = controller;
    copyTaskRef.current = task;
    setCopyStatus("正在读取完整记录…");
    task.promise
      .then((raw) => {
        if (!isCurrent() || raw === STALE_SESSION_RESPONSE) return;
        const parsed = parseRolloutText(raw)[0];
        const source = copyableEntry(parsed);
        if (source) setCopySourceEntry({ ...source, lineNumber: entry.lineNumber });
        else {
          copyPending.current = false;
          setCopyStatus("没有可复制内容");
        }
      })
      .catch((reason) => {
        if (!isCurrent() || reason?.name === "AbortError") return;
        copyPending.current = false;
        if (isStaleRevision(reason)) {
          setCopyStatus("轨迹版本已变化，正在恢复当前页");
          void onRevisionStale?.(entry.lineNumber, locator.revision);
        } else setCopyStatus(reason?.message || "完整记录读取失败");
      })
      .finally(() => {
        if (copySequenceRef.current === token) {
          copyControllerRef.current = null;
          copyTaskRef.current = null;
        }
      });
  }

  function toggleCollapse() {
    const nextCollapsed = !collapsed;
    if (nextCollapsed) {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      setHighlighted(true);
      highlightTimer.current = setTimeout(() => {
        highlightTimer.current = null;
        setHighlighted(false);
      }, 3000);
    }
    if (rawExpanded) onRawExpandedChange(readingKey, false);
    onToggleCollapse(readingKey, nextCollapsed, bodyRef.current, entryId);
  }

  function onRawToggle(event) {
    onRawExpandedChange(readingKey, event.currentTarget.open);
  }

  return (
    <article
      ref={virtualRef}
      className={`event-card ${entry.kind} ${isLast ? "is-last" : ""}`}
      role="listitem"
      aria-posinset={lineIndex + 1}
      aria-setsize={totalEntries}
      tabIndex={-1}
      data-event-key={entryId}
      data-virtual-key={entryId}
      data-virtual-index={entryIndex}
      data-entry-index={entryIndex}
      data-line-number={entry.lineNumber}
    >
      <div className="event-rail"><span className="event-marker" /></div>
      <div ref={bodyRef} className={`event-body ${collapsed ? "collapsed" : ""} ${highlighted ? "collapse-highlight" : ""}`}>
        <div className="event-meta">
          <span className="event-title" title={entry.titleTruncated ? "标题预览已省略；完整记录可在原始 JSON 中查看。" : undefined}>{entry.title}</span>
          <time>{formatDate(entry.timestamp)}</time>
          <span className="line-number">第 {entry.lineNumber} 行</span>
        </div>
        <nav
          className={`event-controls ${controlsVisible ? "is-visible" : ""}`}
          aria-label={`第 ${entry.lineNumber} 行 JSONL 对象操作`}
          aria-hidden={!controlsVisible}
        >
          <button type="button" onClick={copyEntryContent} aria-label="复制对话" title="复制对话" tabIndex={controlsVisible ? 0 : -1}>复制对话</button>
          {copyPending.current && <button type="button" onClick={cancelCopy} aria-label="取消复制" title="取消复制" tabIndex={controlsVisible ? 0 : -1}>取消</button>}
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label={collapsed ? `展开第 ${entry.lineNumber} 行 JSONL 对象` : `收起第 ${entry.lineNumber} 行 JSONL 对象`}
            title={collapsed ? "展开对象" : "收起对话"}
            tabIndex={controlsVisible ? 0 : -1}
          >
            {collapsed ? "展开" : "收起对话"}
          </button>
          <button type="button" data-timeline-action="first" onClick={(event) => onScrollToEntry(event, "first")} aria-label="回到会话开始处" title="回到会话开始处" tabIndex={controlsVisible ? 0 : -1}>↑</button>
          <button type="button" data-timeline-action="last" onClick={(event) => onScrollToEntry(event, "last")} aria-label="跳转到会话末尾" title="跳转到会话末尾" tabIndex={controlsVisible ? 0 : -1}>↓</button>
          <span className="event-copy-status" role="status" aria-live="polite">{copyStatus}</span>
        </nav>
        {!collapsed && (
          <EventContent
            entry={entry}
            entryId={entryId}
            summary={summary}
            cursor={safeCursor}
            onBodyCursorChange={handleBodyCursorChange}
          />
        )}
        {!collapsed && entry.kind === "invalid" && <p className="warning">该行不是有效 JSON，原文仍保留在下方。</p>}
        {!collapsed && (
          <details open={rawExpanded} onToggle={onRawToggle}>
            <summary>原始 JSON</summary>
            {rawExpanded && (
              <RawContent
                entry={entry}
                sessionId={sessionId}
                offset={rawOffset}
                offsetHistory={rawOffsetHistory}
                onOffsetChange={onRawOffsetChange}
                onRevisionStale={onRevisionStale}
                active={active}
              />
            )}
          </details>
        )}
        {copySourceEntry && copySummary && globalThis.document?.body && createPortal(
          <div className="event-copy-source" aria-hidden="true" ref={copySourceRef}>
            <EventContent
              entry={copySourceEntry}
              entryId={entryId}
              summary={copySummary}
              cursor={safeCursor}
              full
            />
          </div>,
          globalThis.document.body,
          `${entryId}:copy-source`,
        )}
      </div>
    </article>
  );
});
