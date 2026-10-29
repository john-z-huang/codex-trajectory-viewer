import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("SQLite 共享搜索跨页及回绕，过滤提示、隐藏延后、刷新取消和快照错误保持隔离", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const calls = [];
  const late = deferred();
  const lateRefresh = deferred();
  let revision = "sqlite-v1";
  let pageSize = 1;
  let staleBodyRead = false;
  const raw = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "JSONL independent" } });
  const item = (index) => ({ item_id: `item-${index}`, item_json: JSON.stringify(index === 2 ? { type: "userMessage", content: [{ type: "text", text: "Needle second" }] } : { type: "agentMessage", text: `Needle ${index}` }) });
  const history = (page) => ({ database: "thread_history_1.sqlite", available: true, tables: [
    { table: "thread_turns", rows: [{ turn_id: "turn-info" }] },
    { table: "thread_items", rows: Array.from({ length: Math.min(pageSize, 3 - (page - 1) * pageSize) }, (_, index) => item((page - 1) * pageSize + index + 1)), pagination: { page, pageSize, totalRows: 3, hasMore: page * pageSize < 3 } },
  ] });
  const windowData = () => ({
    id: "synthetic", title: revision, supplementRevision: revision,
    supplement: [{ database: "state_5.sqlite", available: true, tables: [{ table: "threads", rows: [{ title: "description only" }] }] }, history(1)],
    rollout: { revision: "jsonl-v1", totalLines: 1, totalBytes: raw.length, pageSize: 1, startLine: 1, endLine: 1 },
    lines: [{ lineNumber: 1, raw, byteLength: raw.length }],
  });
  const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
  const globals = {
    window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost/");
      const view = url.searchParams.get("view");
      const call = { url, view, signal: options.signal }; calls.push(call);
      if (view === "window") return response(windowData());
      if (view === "history") return response({ historyOnly: true, supplement: [history(Number(url.searchParams.get("historyPage")))] });
      if (view === "history-search") {
        const query = url.searchParams.get("q");
        if (query === "Late") return late.promise;
        if (query === "LateRefresh") return lateRefresh.promise;
        if (query === "Conflict") return response({ error: "stale", code: "stale_revision" }, 409);
        const after = Number(url.searchParams.get("afterIndex"));
        const rowIndex = query === "Hidden" ? 2 : query === "Needle" ? after === 2 ? 3 : 2 : null;
        return response({ rowIndex, page: rowIndex === null ? null : Math.ceil(rowIndex / pageSize), totalRows: 3 });
      }
      throw new Error(`Unexpected view ${view}`);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  let vite;
  try {
    vite = await createServer({ configFile: new URL("../vite.config.js", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
    const { SessionPanel } = await vite.ssrLoadModule("/src/components/SessionPanel.jsx");
    const host = window.document.createElement("section"); host.className = "session-tab-panel";
    Object.defineProperty(host, "clientHeight", { value: 20000 });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 20000, height: 20000 }); host.scrollTo = () => {};
    window.document.body.append(host); root = createRoot(host);
    const render = (refreshVersion = 0) => root.render(React.createElement(SessionPanel, { sessionId: "synthetic", active: true, refreshVersion }));
    await act(async () => { render(); await new Promise((resolve) => setImmediate(resolve)); });
    const tabs = () => host.querySelectorAll('[role="tab"]');
    const sqlite = () => host.querySelector(".sqlite-conversation");
    const click = async (node) => { assert.ok(node); await act(async () => { node.click(); await new Promise((resolve) => setImmediate(resolve)); }); };
    await click(tabs()[1]);
    const form = () => sqlite().querySelector(".timeline-find");
    const inputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    async function submit(query) {
      await act(async () => {
        if (query !== undefined) { inputValue.call(form().querySelector("input"), query); form().querySelector("input").dispatchEvent(new window.Event("input", { bubbles: true })); }
        form().dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    await submit("Needle");
    assert.equal(sqlite().querySelector(".event-card").dataset.lineNumber, "2");
    assert.match(sqlite().textContent, /第 2 \/ 3 条/);
    await submit();
    assert.equal(sqlite().querySelector(".event-card").dataset.lineNumber, "3");
    await submit();
    assert.equal(sqlite().querySelector(".event-card").dataset.lineNumber, "2");
    assert.deepEqual(calls.filter((call) => call.view === "history-search").map((call) => Number(call.url.searchParams.get("afterIndex"))), [0, 2, 3]);
    assert.ok(calls.filter((call) => call.view === "history-search" || call.view === "history").every((call) => call.url.searchParams.get("supplementRevision") === "sqlite-v1"));
    assert.ok([...sqlite().querySelectorAll(".timeline-find input")].every((input) => input.value === "Needle"));
    await submit("absent");
    assert.match(sqlite().textContent, /未找到匹配记录/);
    const searchCount = calls.filter((call) => call.view === "history-search").length;
    await submit("x".repeat(257));
    assert.equal(calls.filter((call) => call.view === "history-search").length, searchCount);
    assert.match(sqlite().textContent, /最多 256/);
    const userFilter = [...sqlite().querySelectorAll("label")].find((node) => node.textContent === "用户消息").querySelector("input");
    await click(userFilter);
    await submit("Hidden");
    assert.match(sqlite().textContent, /第 2 条已被类型筛选隐藏/);
    assert.equal(userFilter.checked, false);
    await click([...sqlite().querySelectorAll(".conversation-type-filter button")].find((node) => node.textContent === "显示全部"));
    await submit("Late");
    assert.equal(form().querySelector("button").textContent, "查找中…");
    const pageCalls = calls.filter((call) => call.view === "history").length;
    await click(tabs()[0]);
    late.resolve(response({ rowIndex: 3, page: 3, totalRows: 3 }));
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(calls.filter((call) => call.view === "history").length, pageCalls, "hidden search completion cannot load another history page");
    await click(tabs()[1]);
    assert.equal(sqlite().querySelector(".event-card").dataset.lineNumber, "3");
    await submit("Conflict");
    assert.match(host.querySelector(".error-banner").textContent, /SQLite 数据已变化/);
    assert.equal(calls.filter((call) => call.view === "window").length, 1, "a stale search never triggers an implicit refresh");
    await submit("LateRefresh");
    const pending = calls.at(-1);
    revision = "sqlite-v2";
    await act(async () => { render(1); await new Promise((resolve) => setImmediate(resolve)); });
    assert.equal(pending.signal.aborted, true);
    lateRefresh.resolve({ ok: true, status: 200, json: async () => { staleBodyRead = true; return { rowIndex: 3, page: 3, totalRows: 3 }; } });
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(staleBodyRead, false);
    assert.equal(sqlite().querySelector(".event-card").dataset.lineNumber, "1");
    assert.match(host.querySelector(".session-header").textContent, /sqlite-v2/);
    assert.match(host.querySelector(".session-source-panel").textContent, /JSONL independent/);
    assert.equal(host.querySelector(".sqlite-session-info .timeline-find"), null);
    pageSize = 3; revision = "sqlite-v3";
    await act(async () => { render(2); await new Promise((resolve) => setImmediate(resolve)); });
    const beforeSamePage = calls.filter((call) => call.view === "history").length;
    await submit("Needle");
    assert.match(sqlite().textContent, /第 2 \/ 3 条/);
    await submit();
    assert.match(sqlite().textContent, /第 3 \/ 3 条/);
    await submit();
    assert.match(sqlite().textContent, /第 2 \/ 3 条/);
    assert.equal(calls.filter((call) => call.view === "history").length, beforeSamePage, "same-page next-match advances and wraps without reloading");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, value] of original) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
  }
});
