import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import MarkdownContent from "./MarkdownContent.jsx";
import { ConversationControls } from "./ConversationControls.jsx";
import { projectSqliteRow, textChunkOffsets } from "../lib/sqlite-history.js";

function stringifyRow(row) {
  try {
    const text = JSON.stringify(row, null, 2);
    return text === undefined ? String(row) : text;
  } catch {
    return String(row);
  }
}

function renderedText(element) {
  return element?.innerText ?? element?.textContent ?? "";
}

function normalizeCopyText(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function TextPager({ text, label, kind, page, onPageChange }) {
  const offsets = useMemo(() => textChunkOffsets(text), [text]);
  const pageCount = Math.max(1, offsets.length - 1);
  const currentPage = Math.min(page, pageCount - 1);
  const start = offsets[currentPage] ?? 0;
  const end = offsets[currentPage + 1] ?? text.length;
  const segment = text.slice(start, end);

  return (
    <section className="sqlite-history-block event-content-block" aria-label={label}>
      {label && <h4>{label}</h4>}
      {kind === "markdown"
        ? <MarkdownContent>{segment}</MarkdownContent>
        : <pre className="sqlite-history-plain event-text tool-output-plain">{segment}</pre>}
      {pageCount > 1 && (
        <div className="sqlite-text-pager event-fragment-controls">
          <span>第 {currentPage + 1} / {pageCount} 段 · 共 {text.length} 个字符</span>
          <button type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 0}>上一段</button>
          <button type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= pageCount - 1}>下一段</button>
        </div>
      )}
    </section>
  );
}

function FullSqliteContent({ blocks }) {
  return (
    <div className="event-content">
      {blocks.map((block, index) => (
        <div className="event-content-block" key={`${block.label}-${index}`}>
          {block.label && <h4 className="sqlite-history-copy-label">{block.label}</h4>}
          {block.kind === "markdown"
            ? <MarkdownContent>{block.text}</MarkdownContent>
            : <pre className="event-text tool-output-plain">{block.text}</pre>}
        </div>
      ))}
    </div>
  );
}

export function SqliteHistoryCard({
  table,
  row,
  index,
  active = true,
  controlsVisible = true,
  onNavigateBoundary,
}) {
  const projection = projectSqliteRow(table, row);
  const id = useId();
  const cardRef = useRef(null);
  const activeRef = useRef(active);
  const highlightTimer = useRef(null);
  const copySequenceRef = useRef(0);
  const copyPendingRef = useRef(false);
  const copySourceRef = useRef(null);
  const copyRowRef = useRef(row);
  const shouldCenterAfterCollapse = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawPage, setRawPage] = useState(0);
  const [blockPages, setBlockPages] = useState({});
  const [copyPending, setCopyPending] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [copySource, setCopySource] = useState(null);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  useLayoutEffect(() => {
    if (copyRowRef.current === row) return;
    copyRowRef.current = row;
    copySequenceRef.current += 1;
    copyPendingRef.current = false;
    setRawPage(0);
    setCopyPending(false);
    setCopyStatus("");
    setCopySource(null);
  }, [row]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    copySequenceRef.current += 1;
    copyPendingRef.current = false;
  }, []);

  const rawText = useMemo(() => rawOpen ? stringifyRow(row) : null, [rawOpen, row]);
  const rawOffsets = useMemo(() => rawText == null ? [0] : textChunkOffsets(rawText), [rawText]);
  const rawPageCount = Math.max(1, rawOffsets.length - 1);
  const currentRawPage = Math.min(rawPage, rawPageCount - 1);
  const rawStart = rawOffsets[currentRawPage] ?? 0;
  const rawEnd = rawOffsets[currentRawPage + 1] ?? rawText?.length ?? 0;

  function setCopyPendingState(value) {
    copyPendingRef.current = value;
    setCopyPending(value);
  }

  function finishCopy(token, status) {
    if (copySequenceRef.current !== token) return;
    copyPendingRef.current = false;
    setCopyPending(false);
    setCopyStatus(status);
  }

  async function writeCopy(text, token) {
    if (copySequenceRef.current !== token) return;
    const normalized = normalizeCopyText(text);
    if (!normalized) {
      finishCopy(token, "没有可复制内容");
      return;
    }
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await clipboard.writeText(normalized);
      finishCopy(token, "已复制");
    } catch {
      finishCopy(token, "复制失败");
    }
  }

  useLayoutEffect(() => {
    if (!copySource) return;
    const { token } = copySource;
    const text = renderedText(copySourceRef.current?.querySelector(".event-content"));
    setCopySource(null);
    void writeCopy(text, token);
  }, [copySource]);

  function copyConversation() {
    if (!activeRef.current || copyPendingRef.current) return;
    const blocks = projection.blocks.filter((block) => typeof block?.text === "string" && block.text.length > 0);
    if (!blocks.length) {
      setCopyStatus("没有可复制内容");
      return;
    }
    const token = copySequenceRef.current + 1;
    copySequenceRef.current = token;
    setCopyPendingState(true);
    setCopyStatus("正在复制…");
    setCopySource({ token, blocks });
  }

  function cancelCopy() {
    if (!copyPendingRef.current) return;
    copySequenceRef.current += 1;
    copyPendingRef.current = false;
    setCopyPending(false);
    setCopySource(null);
    setCopyStatus("已取消复制");
  }

  function centerCardWhenNeeded() {
    if (!activeRef.current) return;
    const card = cardRef.current;
    const panel = card?.closest(".session-tab-panel");
    const meta = card?.querySelector(".event-meta");
    const panelRect = panel?.getBoundingClientRect();
    const metaRect = meta?.getBoundingClientRect();
    const panelHeight = panel?.clientHeight || panelRect?.height || 0;
    const visible = panelRect && metaRect
      && metaRect.bottom > panelRect.top
      && metaRect.top < panelRect.top + panelHeight;
    if (visible || !panel || !panelRect) return;
    const cardRect = card.getBoundingClientRect();
    const targetTop = panel.scrollTop + cardRect.top - panelRect.top - (panelHeight - cardRect.height) / 2;
    const maxScrollTop = Math.max(0, panel.scrollHeight - panelHeight);
    panel.scrollTo?.({ top: Math.max(0, Math.min(targetTop, maxScrollTop)), behavior: "smooth" });
  }

  useLayoutEffect(() => {
    if (!active || !shouldCenterAfterCollapse.current) return;
    shouldCenterAfterCollapse.current = false;
    centerCardWhenNeeded();
  }, [active, collapsed]);

  function toggleCollapse() {
    if (!activeRef.current) return;
    const nextCollapsed = !collapsed;
    if (nextCollapsed) {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      setHighlighted(true);
      highlightTimer.current = setTimeout(() => {
        highlightTimer.current = null;
        setHighlighted(false);
      }, 3000);
      setRawOpen(false);
      shouldCenterAfterCollapse.current = true;
    } else {
      shouldCenterAfterCollapse.current = false;
    }
    setCollapsed(nextCollapsed);
  }

  function onRawToggle(event) {
    setRawOpen(event.currentTarget.open);
  }

  function updateBlockPage(key, page) {
    setBlockPages((current) => ({ ...current, [key]: Math.max(0, page) }));
  }

  return (
    <article
      ref={cardRef}
      className="sqlite-history-card"
      data-sqlite-index={index}
      data-sqlite-table={table}
      data-sqlite-id={row?.item_id ?? row?.turn_id ?? row?.goal_id ?? row?.thread_id ?? ""}
      tabIndex={-1}
    >
      <div className={`event-body ${collapsed ? "collapsed" : ""} ${highlighted ? "collapse-highlight" : ""}`}>
        <div className="event-meta sqlite-history-meta">
          <header className="sqlite-history-heading">
            <strong>{projection.title}</strong>
            {projection.actor && <span>{projection.actor}</span>}
            {projection.status && <span className="sqlite-history-status">{projection.status}</span>}
          </header>

          {!!projection.fields.length && (
            <dl className="sqlite-history-fields">
              {projection.fields.map((field, fieldIndex) => (
                <div key={`${field.label}-${fieldIndex}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {projection.warning && <p className="source-note">{projection.warning}；原始数据仍可查看。</p>}
        </div>

        <ConversationControls
          controlsVisible={active && controlsVisible}
          controlsLabel={`第 ${index + 1} 条 SQLite 对话操作`}
          collapsed={collapsed}
          collapsedActionLabel={`收起第 ${index + 1} 条 SQLite 对话`}
          expandedActionLabel={`展开第 ${index + 1} 条 SQLite 对话`}
          onCopy={copyConversation}
          onCancelCopy={cancelCopy}
          copyPending={copyPending}
          copyStatus={copyStatus}
          onToggleCollapse={toggleCollapse}
          onNavigateFirst={(event) => {
            if (activeRef.current) onNavigateBoundary?.(event, "first");
          }}
          onNavigateLast={(event) => {
            if (activeRef.current) onNavigateBoundary?.(event, "last");
          }}
        />

        {!collapsed && (
          <div className="event-content sqlite-history-blocks">
            {projection.blocks.map((block, blockIndex) => {
              const key = `${block.label}-${blockIndex}`;
              return (
                <TextPager
                  key={key}
                  {...block}
                  page={blockPages[key] ?? 0}
                  onPageChange={(page) => updateBlockPage(key, page)}
                />
              );
            })}
            <details className="sqlite-raw-row" open={rawOpen} onToggle={onRawToggle}>
              <summary>原始 JSON</summary>
              {rawOpen && rawText != null && (
                <div id={`${id}-raw`} className="sqlite-raw-content">
                  <div className="sqlite-text-pager">
                    <span>第 {currentRawPage + 1} / {rawPageCount} 段 · 字符 {rawStart + 1}–{rawEnd} / {rawText.length}</span>
                    <button type="button" onClick={() => setRawPage(Math.max(0, currentRawPage - 1))} disabled={currentRawPage <= 0}>上一段</button>
                    <button type="button" onClick={() => setRawPage(Math.min(rawPageCount - 1, currentRawPage + 1))} disabled={currentRawPage >= rawPageCount - 1}>下一段</button>
                  </div>
                  <pre className="sqlite-row">{rawText.slice(rawStart, rawEnd)}</pre>
                </div>
              )}
            </details>
          </div>
        )}

        {copySource && globalThis.document?.body && createPortal(
          <div className="event-copy-source" aria-hidden="true" ref={copySourceRef}>
            <FullSqliteContent blocks={copySource.blocks} />
          </div>,
          globalThis.document.body,
          `${id}:copy-source`,
        )}
      </div>
    </article>
  );
}
