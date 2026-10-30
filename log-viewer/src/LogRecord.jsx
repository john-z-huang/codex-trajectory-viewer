import React, { useState } from "react";

export default function LogRecord({ entry, onCorrelate }) {
  const [copyState, setCopyState] = useState("");
  const record = entry.record;
  const fields = record ? Object.entries(record).filter(([key]) => !["time", "level", "source", "event", "operation_id", "request_id"].includes(key)) : [];
  const errorText = { invalid_json: "此行不是有效 JSON，原文仍可查看。", invalid_record: "此行不是日志对象，原文仍可查看。", line_too_large: "此行超过预览上限。" }[entry.error] ?? entry.error;
  async function copy() {
    try {
      await navigator.clipboard.writeText(entry.raw);
      setCopyState("已复制");
    } catch { setCopyState("复制失败，请展开原文手动复制"); }
  }
  return (
    <article className={"record level-" + (["debug", "info", "warn", "error"].includes(record?.level) ? record.level : "unknown")}>
      <header className="record-header">
        <span className="line-number">行 {entry.line}</span>
        <span className="level-badge">{typeof record?.level === "string" ? record.level : "未知级别"}</span>
        <time>{typeof record?.time === "string" ? record.time : "无时间"}</time>
        <strong>{typeof record?.event === "string" ? record.event : "未知事件"}</strong>
        <span>{typeof record?.source === "string" ? record.source : "未知来源"}</span>
      </header>
      {errorText && <p className="notice">{errorText}</p>}
      {entry.truncated && <p className="notice">此行预览已截断；下载文件可查看完整原文。</p>}
      <div className="correlations">
        {[ ["operation_id", "操作"], ["request_id", "请求"] ].map(([field, label]) => typeof record?.[field] === "string" && (
          <button key={field} onClick={() => onCorrelate(field === "operation_id" ? "operationId" : "requestId", record[field])} title={"筛选相同" + label + " ID"}>
            {label} <code>{record[field]}</code>
          </button>
        ))}
      </div>
      {record && <dl className="record-fields">{fields.slice(0, 24).map(([key, value]) => (
        <React.Fragment key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></React.Fragment>
      ))}</dl>}
      {fields.length > 24 && <p className="notice">另有 {fields.length - 24} 个字段，请查看原始 JSON。</p>}
      <div className="record-actions">
        <details><summary>原始 JSON</summary><pre>{entry.raw}</pre></details>
        <button onClick={copy}>复制{entry.truncated ? "预览" : "原文"}</button>
        <span role="status">{copyState}</span>
      </div>
    </article>
  );
}
