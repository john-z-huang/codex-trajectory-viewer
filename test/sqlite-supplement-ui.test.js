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
      server: { middlewareMode: true, hmr: false },
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
        rows: Array.from({ length: 60 }, (_, index) => ({
          turn_id: `synthetic-turn-${index}`,
          thread_id: "thread-synthetic",
          payload: index === 0 ? "x".repeat(24_000) : `synthetic-row-${index}`,
        })),
        pagination: { page: 1, totalRows: 60, hasMore: true },
      }, {
        table: "thread_items",
        rows: [
          {
            item_type: "userMessage",
            item_json: JSON.stringify({ type: "userMessage", content: [
              { type: "text", text: "**bold user text** and [unsafe](javascript:alert(1))" },
              { type: "image", url: "https://example.invalid/user-image.png" },
            ] }),
            item_id: "synthetic-user-item",
          },
          {
            item_type: "commandExecution",
            item_json: JSON.stringify({ type: "commandExecution", aggregatedOutput: "**plain stdout**" }),
            item_id: "synthetic-command-item",
          },
          {
            item_type: "mcpToolCall",
            item_json: JSON.stringify({ type: "mcpToolCall", tool: "read_note", result: { content: [
              { type: "text", text: "**mcp result text**" },
              { type: "image", url: "https://example.invalid/mcp-image.png" },
            ] } }),
            item_id: "synthetic-mcp-item",
          },
        ],
      }],
    }];

    await act(async () => root.render(React.createElement(SqliteSupplement, {
      sources,
      historyLoading: false,
      onLoadHistoryPage: (page) => requestedPages.push(page),
    })));
    const table = host.querySelector("details.sqlite-table");
    assert.equal(host.querySelector(".sqlite-history-card"), null);
    assert.equal(host.querySelector(".sqlite-row"), null, "raw rows stay collapsed");
    assert.equal(host.querySelector(".history-pager"), null);

    await act(async () => table.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(table.querySelectorAll(".sqlite-history-card").length, 60, "the client does not truncate server-returned non-history rows to 50");
    assert.match(host.querySelector(".sqlite-history-card")?.textContent ?? "", /synthetic-turn-0/);
    assert.equal(host.querySelector(".sqlite-row"), null, "raw row serialization is lazy");
    assert.equal(host.querySelectorAll(".history-pager button").length, 2);
    await act(async () => host.querySelectorAll(".history-pager button")[1].click());
    assert.deepEqual(requestedPages, [2]);

    const rawDetails = host.querySelector("details.sqlite-raw-row");
    assert.equal(rawDetails.open, false);
    assert.equal(rawDetails.querySelector("pre"), null, "raw SQLite JSON is not mounted while collapsed");
    await act(async () => rawDetails.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(rawDetails.open, true, "the native disclosure opens through its summary");
    const rawChunk = host.querySelector(".sqlite-row");
    assert.ok(rawChunk.textContent.length <= 8_000, "only one bounded raw chunk mounts at once");
    const expectedRawRow = { ...sources[0].tables[0].rows[0], payload: `refreshed-payload-${"z".repeat(24_000)}` };
    const refreshedSources = [{
      ...sources[0],
      tables: [
        { ...sources[0].tables[0], rows: [expectedRawRow, ...sources[0].tables[0].rows.slice(1)] },
        sources[0].tables[1],
      ],
    }];
    await act(async () => root.render(React.createElement(SqliteSupplement, {
      sources: refreshedSources,
      historyLoading: false,
      onLoadHistoryPage: (page) => requestedPages.push(page),
    })));
    assert.match(host.querySelector(".sqlite-row")?.textContent ?? "", /refreshed-payload/);
    assert.doesNotMatch(host.querySelector(".sqlite-row")?.textContent ?? "", /x{100}/, "expanded raw data follows the refreshed row");
    const rawParts = [host.querySelector(".sqlite-row").textContent];
    const rawPagerButtons = () => host.querySelectorAll(".sqlite-raw-content .sqlite-text-pager button");
    while (!rawPagerButtons()[1].disabled) {
      await act(async () => rawPagerButtons()[1].click());
      rawParts.push(host.querySelector(".sqlite-row").textContent);
    }
    assert.equal(rawParts.join(""), JSON.stringify(expectedRawRow, null, 2));
    assert.equal(rawParts.join("").length > 24_000, true);

    await act(async () => table.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(host.querySelector(".sqlite-history-card"), null);
    assert.equal(host.querySelector(".history-pager"), null);

    const itemTable = host.querySelectorAll("details.sqlite-table")[1];
    await act(async () => itemTable.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(itemTable.querySelectorAll(".sqlite-history-card").length, 3);
    assert.equal(itemTable.querySelector(".markdown-body strong")?.textContent, "bold user text");
    assert.equal(itemTable.querySelectorAll("img").length, 0, "image content never loads remote images");
    assert.notEqual(itemTable.querySelector(".markdown-body a")?.getAttribute("href"), "javascript:alert(1)");
    assert.equal(itemTable.querySelector(".sqlite-history-plain")?.textContent, "{\n  \"type\": \"image\",\n  \"url\": \"https://example.invalid/user-image.png\"\n}");
    assert.equal([...itemTable.querySelectorAll(".sqlite-history-plain")].some((node) => node.textContent === "**plain stdout**"), true);
    assert.equal([...itemTable.querySelectorAll(".markdown-body strong")].some((node) => node.textContent === "mcp result text"), true);
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
