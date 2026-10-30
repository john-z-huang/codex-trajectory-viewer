import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { formatBytes, readJson } from "./api.js";
import FilePanel from "./FilePanel.jsx";
import { initialWorkspace, workspaceReducer } from "./tabs.js";

export default function App() {
  const [files, setFiles] = useState([]);
  const [{ tabs, activeId, notice: tabNotice }, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  const [query, setQuery] = useState("");
  const [date, setDate] = useState("");
  const [source, setSource] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState(0);
  const flight = useRef(null);
  const loadFiles = useCallback(async () => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true); setError("");
    try {
      const value = await readJson("/api/logs", { signal: controller.signal });
      if (!controller.signal.aborted) { setFiles(value.files); setWarnings(value.warnings); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void loadFiles(); return () => flight.current?.abort(); }, [loadFiles]);

  function open(file) {
    dispatch({ type: "open", file });
  }
  function close(id) {
    dispatch({ type: "close", id });
  }
  function tabKey(event, index) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : null;
    if (next === null) return;
    event.preventDefault(); dispatch({ type: "activate", id: tabs[next].id }); document.getElementById("tab-" + tabs[next].id)?.focus();
  }
  const dates = [...new Set(files.map((file) => file.date))].sort().reverse();
  const filtered = files.filter((file) => (!date || file.date === date) && (!source || file.source === source) && (!query || (file.date + " " + file.name).toLowerCase().includes(query.toLowerCase())));
  const visible = filtered.slice(0, 500);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">≋</span><div><h1>Codex 日志查看器</h1><p>本机诊断 · 只读浏览</p></div></div>
        <button className="primary refresh" disabled={loading} onClick={() => { void loadFiles(); setRefreshKey((value) => value + 1); }}>{loading ? "刷新中…" : "刷新日志"}</button>
        <label>查找文件<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="日期、来源或实例 ID" /></label>
        <div className="sidebar-selects"><label>日期<select value={date} onChange={(event) => setDate(event.target.value)}><option value="">全部日期</option>{dates.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>文件来源<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">全部来源</option>{["server", "http", "browser"].map((value) => <option key={value}>{value}</option>)}</select></label></div>
        <p className="file-count">{filtered.length} 个文件{filtered.length > 500 && "，仅显示前 500 个，请筛选"}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {warnings > 0 && <p className="notice">{warnings} 个目录或文件无法读取或不符合安全要求。</p>}
        <nav aria-label="日志文件" className="file-list">{visible.map((file, index) => <React.Fragment key={file.id}>
          {(index === 0 || visible[index - 1].date !== file.date) && <h2 className="date-heading">{file.date}</h2>}
          <button className={"file-item " + (activeId === file.id ? "selected" : "")} onClick={() => open(file)} title={file.name} aria-current={activeId === file.id ? "page" : undefined}>
            <span className="file-source">{file.source}<small>#{file.segment} · {formatBytes(file.size)}</small></span><code>{file.instanceId}</code>
          </button>
        </React.Fragment>)}</nav>
        {!loading && !files.length && !error && <p className="empty">尚无日志文件。启动轨迹查看器产生日志后，点击刷新。</p>}
        {!loading && files.length > 0 && !filtered.length && <p className="empty">没有匹配的文件。</p>}
        <p className="local-note">仅连接本机日志服务。手动刷新获取新增记录。</p>
      </aside>
      <main className="workspace">
        <div className="workspace-heading"><span>日志工作区</span><span>{tabs.length} / 8 个文件</span></div>
        <div role="tablist" aria-label="已打开日志" className="tabs">{tabs.map((file, index) => <div className={"tab " + (activeId === file.id ? "active" : "")} key={file.id}>
          <button id={"tab-" + file.id} role="tab" aria-selected={activeId === file.id} aria-controls={"panel-" + file.id} tabIndex={activeId === file.id ? 0 : -1} onClick={() => dispatch({ type: "activate", id: file.id })} onKeyDown={(event) => tabKey(event, index)}>{file.source} · {file.date} · #{file.segment}</button>
          <button className="close-tab" aria-label={"关闭 " + file.name} onClick={() => close(file.id)}>×</button>
        </div>)}</div>
        {tabNotice && <p className="notice" role="status">{tabNotice}</p>}
        {!tabs.length && <div className="welcome"><span className="welcome-icon">≋</span><h2>选择一个日志文件</h2><p>按日期与来源浏览，使用操作 ID 或请求 ID 定位关联记录。</p><p>支持原文、复制和下载；日志源始终只读。</p></div>}
        {tabs.map((file) => <FilePanel key={file.id} file={file} active={activeId === file.id} refreshKey={refreshKey} />)}
      </main>
    </div>
  );
}
