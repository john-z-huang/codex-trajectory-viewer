import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("SQLite 行 JSON 和分页控件只在表格展开时挂载", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
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
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { SqliteSupplement } = await vite.ssrLoadModule("/src/components/SqliteSupplement.jsx");
    const host = window.document.createElement("div");
    window.document.body.append(host);
    root = createRoot(host);
    const requestedPages = [];
    const sources = [{
      database: "thread_history_1.sqlite",
      available: true,
      tables: [{
        table: "thread_turns",
        rows: [{ turn_id: "synthetic-turn", payload: "synthetic-row" }],
        pagination: { page: 1, totalRows: 51, hasMore: true },
      }],
    }];

    await act(async () => root.render(React.createElement(SqliteSupplement, {
      sources,
      historyLoading: false,
      onLoadHistoryPage: (page) => requestedPages.push(page),
    })));
    const table = host.querySelector("details.sqlite-table");
    assert.equal(host.querySelector(".sqlite-row"), null);
    assert.equal(host.querySelector(".history-pager"), null);

    await act(async () => table.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.match(host.querySelector(".sqlite-row")?.textContent ?? "", /synthetic-row/);
    assert.equal(host.querySelectorAll(".history-pager button").length, 2);
    await act(async () => host.querySelectorAll(".history-pager button")[1].click());
    assert.deepEqual(requestedPages, [2]);

    await act(async () => table.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(host.querySelector(".sqlite-row"), null);
    assert.equal(host.querySelector(".history-pager"), null);
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
