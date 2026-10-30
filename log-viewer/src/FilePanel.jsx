import React, { useEffect, useRef, useState } from "react";
import { downloadUrl, pageUrl, readJson } from "./api.js";
import LogRecord from "./LogRecord.jsx";

const EMPTY_FILTERS = { level: "", source: "", q: "", operationId: "", requestId: "" };

export default function FilePanel({ file, active, refreshKey }) {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [target, setTarget] = useState({ afterLine: 0 });
  const [history, setHistory] = useState([]);
  const [jump, setJump] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [epoch, setEpoch] = useState(0);
  const revision = useRef("");
  const refresh = useRef({ refreshKey, epoch });

  useEffect(() => {
    if (refresh.current.refreshKey !== refreshKey || refresh.current.epoch !== epoch) {
      revision.current = "";
      refresh.current = { refreshKey, epoch };
    }
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError(null);
    readJson(pageUrl(file.id, { filters, target, revision: revision.current }), { signal: controller.signal }).then((value) => {
      if (!current) return;
      revision.current = value.revision;
      setData(value);
    }).catch((failure) => {
      if (current && failure.name !== "AbortError") setError(failure);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [file.id, filters, target, refreshKey, epoch]);

  function apply(next) {
    setDraft(next);
    setFilters(next);
    setTarget({ afterLine: 0 });
    setHistory([]);
  }
  function navigate(next) {
    setHistory((previous) => [...previous, target].slice(-100));
    setTarget(next);
  }
  function previous() {
    if (!history.length) return;
    setTarget(history.at(-1));
    setHistory((value) => value.slice(0, -1));
  }
  function reload() {
    setHistory([]);
    setTarget({ afterLine: 0 });
    setEpoch((value) => value + 1);
  }
  function field(key, value) { setDraft((previous) => ({ ...previous, [key]: value })); }
  const panelId = "panel-" + file.id;
  return (
    <section id={panelId} role="tabpanel" aria-labelledby={"tab-" + file.id} hidden={!active} className="file-panel" aria-busy={loading}>
      <div className="file-heading">
        <div><h2>{file.source} · {file.date}</h2><p className="filename">{file.name}</p></div>
        <div className="heading-actions">
          <button onClick={reload} disabled={loading}>刷新此文件</button>
          {data && <a className="button" href={downloadUrl(file.id, data.revision)} download>下载快照文件</a>}
        </div>
      </div>
      <form className="filters" onSubmit={(event) => { event.preventDefault(); apply({ ...draft }); }}>
        <label>级别<select value={draft.level} onChange={(event) => field("level", event.target.value)}><option value="">全部级别</option>{["debug", "info", "warn", "error"].map((level) => <option key={level}>{level}</option>)}</select></label>
        <label>来源<select value={draft.source} onChange={(event) => field("source", event.target.value)}><option value="">全部来源</option>{["server", "http", "browser"].map((source) => <option key={source}>{source}</option>)}</select></label>
        <label className="query-field">文本或事件<input value={draft.q} maxLength={256} onChange={(event) => field("q", event.target.value)} placeholder="区分大小写的原文字面查找" /></label>
        <label>操作 ID<input value={draft.operationId} maxLength={256} onChange={(event) => field("operationId", event.target.value)} /></label>
        <label>请求 ID<input value={draft.requestId} maxLength={256} onChange={(event) => field("requestId", event.target.value)} /></label>
        <button type="submit">应用筛选</button><button type="button" onClick={() => apply({ ...EMPTY_FILTERS })}>清空筛选</button>
      </form>
      <div className="page-bar">
        <span role="status">{loading ? "读取中…" : data ? "匹配 " + data.matchedLines + " / 共 " + data.totalLines + " 行" : "尚未读取"}</span>
        <button disabled={loading || !data} onClick={() => navigate({ afterLine: 0 })}>首页</button>
        <button disabled={loading || !history.length} onClick={previous}>上一页</button>
        <button disabled={loading || !data?.hasMore} onClick={() => navigate({ afterLine: data.nextAfterLine })}>下一页</button>
        <button disabled={loading || !data} onClick={() => navigate({ line: "last" })}>末页</button>
        <form onSubmit={(event) => { event.preventDefault(); const line = Number(jump); if (Number.isSafeInteger(line) && line > 0) navigate({ line }); }}>
          <label>原始行号<input type="number" min="1" step="1" value={jump} onChange={(event) => setJump(event.target.value)} /></label><button disabled={loading}>跳转</button>
        </form>
      </div>
      {error && <div role="alert" className="error">{error.status === 409 ? "日志快照已变化，请刷新此文件。已显示内容仍保留。" : error.message}</div>}
      <div className="records">
        {data?.entries.map((entry) => <LogRecord key={data.revision + ":" + entry.line} entry={entry} onCorrelate={(key, value) => apply({ ...filters, [key]: value })} />)}
        {data && !data.entries.length && <p className="empty">没有匹配记录。可清空筛选、返回首页或手动刷新。</p>}
      </div>
    </section>
  );
}
