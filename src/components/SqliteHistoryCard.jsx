import { useId, useMemo, useRef, useState } from "react";
import MarkdownContent from "./MarkdownContent.jsx";
import { projectSqliteRow, textChunkOffsets } from "../lib/sqlite-history.js";

function stringifyRow(row) {
  try {
    const text = JSON.stringify(row, null, 2);
    return text === undefined ? String(row) : text;
  } catch {
    return String(row);
  }
}

function TextPager({ text, label, kind }) {
  const [page, setPage] = useState(0);
  const offsets = useMemo(() => textChunkOffsets(text), [text]);
  const pageCount = Math.max(1, offsets.length - 1);
  const currentPage = Math.min(page, pageCount - 1);
  const start = offsets[currentPage] ?? 0;
  const end = offsets[currentPage + 1] ?? text.length;
  const segment = text.slice(start, end);

  return (
    <section className="sqlite-history-block" aria-label={label}>
      {label && <h4>{label}</h4>}
      {kind === "markdown"
        ? <MarkdownContent>{segment}</MarkdownContent>
        : <pre className="sqlite-history-plain">{segment}</pre>}
      {pageCount > 1 && (
        <div className="sqlite-text-pager">
          <span>第 {currentPage + 1} / {pageCount} 段 · 共 {text.length} 个字符</span>
          <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 0}>上一段</button>
          <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>下一段</button>
        </div>
      )}
    </section>
  );
}

function RawSqliteRow({ row, label }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const previousRow = useRef(row);
  if (previousRow.current !== row) {
    previousRow.current = row;
    if (page !== 0) setPage(0);
  }
  const rawText = useMemo(() => open ? stringifyRow(row) : null, [open, row]);
  const offsets = useMemo(() => rawText == null ? [0] : textChunkOffsets(rawText), [rawText]);
  const pageCount = Math.max(1, offsets.length - 1);
  const currentPage = Math.min(page, pageCount - 1);
  const start = offsets[currentPage] ?? 0;
  const end = offsets[currentPage + 1] ?? rawText?.length ?? 0;

  function toggle() {
    setOpen((current) => !current);
    setPage(0);
  }

  return (
    <div className="sqlite-raw-row">
      <button
        type="button"
        className="sqlite-raw-toggle"
        aria-expanded={open}
        aria-label={open ? `隐藏原始行：${label}` : `查看原始行：${label}`}
        aria-controls={open ? `${id}-raw` : undefined}
        onClick={toggle}
      >
        {open ? "隐藏原始行" : "查看原始行"}
      </button>
      {rawText != null && (
        <div id={`${id}-raw`} className="sqlite-raw-content">
          <div className="sqlite-text-pager">
            <span>第 {currentPage + 1} / {pageCount} 段 · 字符 {start + 1}–{end} / {rawText.length}</span>
            <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 0}>上一段</button>
            <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>下一段</button>
          </div>
          <pre className="sqlite-row">{rawText.slice(start, end)}</pre>
        </div>
      )}
    </div>
  );
}

export function SqliteHistoryCard({ table, row, index }) {
  const projection = projectSqliteRow(table, row);
  return (
    <article className="sqlite-history-card" data-sqlite-index={index}>
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
      {!!projection.blocks.length && (
        <div className="sqlite-history-blocks">
          {projection.blocks.map((block, blockIndex) => (
            <TextPager key={`${block.label}-${blockIndex}`} {...block} />
          ))}
        </div>
      )}
      <RawSqliteRow
        row={row}
        label={row?.item_id ?? row?.turn_id ?? row?.goal_id ?? row?.thread_id ?? `${projection.title} ${index + 1}`}
      />
    </article>
  );
}
