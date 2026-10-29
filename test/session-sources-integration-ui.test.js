import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function line(lineNumber, text) {
  const raw = JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
  return { lineNumber, byteLength: new TextEncoder().encode(raw).byteLength, raw };
}

function sqliteRow(itemId, text) {
  return {
    item_type: "userMessage",
    item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] }),
    thread_id: "thread-synthetic",
    turn_id: "turn-synthetic",
    item_id: itemId,
    rollout_ordinal: itemId.endsWith("2") ? 2 : 1,
  };
}

test("SessionPanel 切换 JSONL / SQLite 保留两侧状态，history 翻页不重读详情，隐藏导航延后", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const firstLine = line(1, "needle on the first synthetic line");
  const secondLine = line(2, "needle on the second synthetic line");
  const searchResponse = deferred();
  const pageResponse = deferred();
  const calls = [];
  let pendingPageRequest = null;
  const initialSupplement = [{
    database: "thread_history_1.sqlite",
    available: true,
    tables: [{
      table: "thread_items",
      rows: [sqliteRow("item-page-1", "first SQLite history page")],
      pagination: { page: 1, pageSize: 1, totalRows: 2, hasMore: true },
    }],
  }];
  const nextSupplement = [{
    database: "thread_history_1.sqlite",
    available: true,
    tables: [{
      table: "thread_items",
      rows: [sqliteRow("item-page-2", "second SQLite history page")],
      pagination: { page: 2, pageSize: 1, totalRows: 2, hasMore: false },
    }],
  }];
  initialSupplement.push({
    database: "state_5.sqlite", available: true,
    tables: [{ table: "threads", rows: [{ title: "original SQLite metadata" }] }],
  });
  const windowData = {
    id: "synthetic-session",
    sessionId: "thread-synthetic",
    title: "Synthetic session",
    preview: "Synthetic preview",
    cwd: "/synthetic/project",
    supplement: initialSupplement,
    supplementRevision: "sqlite-revision-synthetic",
    subagents: [],
    rollout: {
      revision: "rollout-revision-synthetic",
      totalLines: 2,
      totalBytes: firstLine.byteLength + secondLine.byteLength,
      pageSize: 1,
      startLine: 1,
      endLine: 1,
    },
    lines: [firstLine],
  };

  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost/");
      const view = url.searchParams.get("view");
      const call = { url, view, signal: options.signal };
      calls.push(call);
      if (view === "window") {
        return { ok: true, status: 200, json: async () => windowData };
      }
      if (view === "history") {
        return { ok: true, status: 200, json: async () => { call.bodyRead = true; return { supplement: nextSupplement, historyOnly: true }; } };
      }
      if (view === "search") return searchResponse.promise;
      if (view === "page") {
        pendingPageRequest = call;
        return pageResponse.promise;
      }
      throw new Error(`Unexpected synthetic view: ${view}`);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let vite;
  let root;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
      logLevel: "error",
    });
    const { SessionPanel } = await vite.ssrLoadModule("/src/components/SessionPanel.jsx");
    const host = window.document.createElement("section");
    host.className = "session-tab-panel";
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(host, "scrollHeight", { configurable: true, value: 1_200 });
    Object.defineProperty(host, "scrollTop", { configurable: true, writable: true, value: 0 });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 960, width: 960 });
    host.scrollTo = ({ top }) => { host.scrollTop = top; };
    window.document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(SessionPanel, {
        sessionId: "synthetic-session",
        refreshVersion: 1,
        active: true,
        onOpenSession: () => {},
      }));
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(calls.filter(({ view }) => view === "window").length, 1);
    assert.equal(host.querySelector(".session-source-panel").querySelectorAll(".event-card").length, 1);

    const firstCard = host.querySelector(".event-card");
    await act(async () => firstCard.querySelector('[aria-label="收起第 1 行 JSONL 对象"]').click());
    assert.ok(firstCard.querySelector(".event-body").classList.contains("collapsed"));

    const findInput = host.querySelector(".timeline-find input");
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    valueSetter.call(findInput, "needle");
    await act(async () => {
      findInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      host.querySelector(".timeline-find button[type=submit]").click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(calls.filter(({ view }) => view === "search").length, 1);

    host.scrollTop = 375;
    const sourceTabs = [...host.querySelectorAll('[role="tab"]')];
    await act(async () => sourceTabs[1].click());
    assert.equal(host.scrollTop, 0);
    const sqliteTable = () => host.querySelector(".sqlite-conversation");
    assert.match(sqliteTable().textContent, /first SQLite history page/);
    await act(async () => sqliteTable().querySelector('[aria-label="下一页"]').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(calls.filter(({ view }) => view === "history").length, 1);
    const historyCall = calls.find(({ view }) => view === "history");
    assert.equal(historyCall.url.searchParams.get("historyPage"), "2");
    assert.equal(historyCall.url.searchParams.get("supplementRevision"), "sqlite-revision-synthetic");
    assert.match(sqliteTable().textContent, /second SQLite history page/);
    assert.match(host.textContent, /original SQLite metadata/, "history navigation retains the original non-history sources");
    await act(async () => sqliteTable().querySelector("details summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(sqliteTable().querySelector("details").open, true, "SQLite raw JSON uses the native disclosure summary");

    searchResponse.resolve({ ok: true, status: 200, json: async () => ({
      revision: "rollout-revision-synthetic",
      lineNumber: 2,
    }) });
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(calls.filter(({ view }) => view === "page").length, 0, "a search resolving in a hidden timeline cannot fetch or navigate a page");
    assert.equal(host.scrollTop, 0, "hidden JSONL completion does not change the SQLite scroll position");

    await act(async () => sourceTabs[0].click());
    assert.equal(host.scrollTop, 375, "the JSONL source restores its own scroll position");
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.ok(pendingPageRequest, "the deferred search navigation loads its page only after JSONL is active again");
    assert.equal(pendingPageRequest.url.searchParams.get("line"), "2");
    const restoredCard = host.querySelector(".event-card");
    assert.ok(restoredCard.querySelector(".event-body").classList.contains("collapsed"), "JSONL collapse state survives the source switch");
    assert.equal(host.querySelector(".timeline-find input").value, "needle", "JSONL search query survives the source switch");

    pageResponse.resolve({ ok: true, status: 200, json: async () => ({
      rollout: {
        revision: "rollout-revision-synthetic",
        totalLines: 2,
        totalBytes: firstLine.byteLength + secondLine.byteLength,
        pageSize: 1,
        startLine: 2,
        endLine: 2,
      },
      lines: [secondLine],
    }) });
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(host.querySelector(".event-card")?.dataset.lineNumber, "2");

    await act(async () => sourceTabs[1].click());
    assert.match(sqliteTable().textContent, /2 条 · 第 2 \/ 2 页/);
    assert.match(sqliteTable().querySelector(".event-raw-view > pre")?.textContent ?? "", /item-page-2/);
    assert.equal(calls.filter(({ view }) => view === "window").length, 1, "switching sources never re-reads the detail window");
    assert.equal(calls.filter(({ view }) => view === "history").length, 1, "returning to SQLite keeps its loaded history page");

    await act(async () => sourceTabs[0].click());
    assert.equal(host.querySelector(".event-card")?.dataset.lineNumber, "2");
    assert.equal(host.querySelector(".timeline-find input").value, "needle");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
