import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("SQLite 说明及轮次独立于共享历史时间线，说明完整且原始 JSON 惰性展示", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let vite;
  let root;
  try {
    vite = await createServer({ configFile: new URL("../vite.config.js", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
    const { SqliteSupplement } = await vite.ssrLoadModule("/src/components/SqliteSupplement.jsx");
    const host = window.document.createElement("section");
    host.className = "session-tab-panel";
    Object.defineProperty(host, "clientHeight", { value: 20000 });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 20000, height: 20000 });
    host.scrollTo = () => {};
    window.document.body.append(host);
    root = createRoot(host);
    const longText = `${"说明内容\n".repeat(3000)}说明末尾`;
    const sandbox = JSON.stringify({ type: "workspace-write", writable_roots: [longText] });
    const stateRows = Array.from({ length: 60 }, (_, index) => ({ id: `thread-${index}`, extra: longText, ...(index < 3 ? { sandbox_policy: [sandbox, `旧格式\n${"😀".repeat(300)}`, null][index] } : {}) }));
    const goal = { objective: longText, future_field: "**纯文本**", nullable: null, sandbox_policy: sandbox };
    const itemRows = [
      { item_id: "user", item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text: "**用户正文** [unsafe](javascript:alert(1))" }, { type: "image", url: "https://example.invalid/image" }] }) },
      { item_id: "command", item_json: JSON.stringify({ type: "commandExecution", aggregatedOutput: "**纯文本输出**" }) },
      { item_id: "mcp", item_json: JSON.stringify({ type: "mcpToolCall", result: { content: [{ type: "text", text: "**MCP 正文**" }] } }) },
    ];
    const sources = [
      { database: "thread_history_1.sqlite", available: true, tables: [{ table: "thread_turns", rows: [{ turn_id: "synthetic-turn", extra: longText }] }, { table: "thread_items", rows: itemRows, pagination: { page: 1, pageSize: 3, totalRows: 6, hasMore: true } }] },
      { database: "goals_1.sqlite", available: true, tables: [{ table: "thread_goals", rows: [goal] }] },
      { database: "state_5.sqlite", available: true, tables: [{ table: "threads", rows: stateRows }] },
    ];
    const pages = [];
    const render = (values = sources) => root.render(React.createElement(SqliteSupplement, { sources: values, onLoadHistoryPage: (page) => pages.push(page) }));
    await act(async () => render());
    const info = host.querySelector(".sqlite-session-info");
    const history = host.querySelector(".sqlite-conversation");
    assert.equal(info.parentElement, history.parentElement, "metadata and conversations have separate sibling containers");
    assert.deepEqual([...info.querySelectorAll(".sqlite-source-heading strong")].map((node) => node.textContent), ["state_5.sqlite", "goals_1.sqlite", "轮次记录"]);
    assert.equal(info.querySelectorAll(".sqlite-session-info-row").length, 62);
    assert.match(info.textContent, /synthetic-turn/);
    assert.equal(history.textContent.includes("synthetic-turn"), false);
    const policyValues = [...info.querySelectorAll("dt")].filter((node) => node.textContent === "sandbox_policy").map((node) => node.nextElementSibling.textContent);
    assert.equal(policyValues[0], "workspace-write（详细配置已省略）");
    assert.match(policyValues[1], /^旧格式 😀+…（已省略）$/u);
    assert.equal(policyValues[2], "null");
    assert.equal(policyValues[3], sandbox);
    assert.ok([...info.querySelectorAll("dd")].some((node) => node.textContent === longText));
    assert.equal(info.querySelector("button, input, .event-card"), null);
    assert.equal(info.querySelector("details[open], pre"), null);
    for (const [index, row] of [[0, stateRows[0]], [60, goal], [61, sources[0].tables[0].rows[0]]]) {
      const disclosure = info.querySelectorAll("details")[index];
      await act(async () => disclosure.querySelector("summary").click());
      assert.equal(disclosure.querySelector("pre").textContent, JSON.stringify(row, null, 2));
      await act(async () => disclosure.querySelector("summary").click());
      assert.equal(disclosure.querySelector("pre"), null);
    }
    assert.equal(history.querySelectorAll(".event-card").length, 3, "the common timeline renders every item");
    assert.equal(history.querySelectorAll(".timeline-toolbar").length, 2);
    assert.equal(history.querySelectorAll(".timeline-find").length, 2);
    assert.equal(history.querySelectorAll(".timeline-jump").length, 2);
    assert.equal(new Set([...history.querySelectorAll("input")].map((node) => node.id)).size, history.querySelectorAll("input").length);
    assert.equal(history.querySelector(".markdown-body strong").textContent, "用户正文");
    assert.equal(history.querySelector("img"), null);
    assert.notEqual(history.querySelector(".markdown-body a")?.getAttribute("href"), "javascript:alert(1)");
    assert.ok([...history.querySelectorAll("pre")].some((node) => node.textContent === "**纯文本输出**"));
    assert.ok([...history.querySelectorAll("strong")].some((node) => node.textContent === "MCP 正文"));
    await act(async () => history.querySelector('[aria-label="下一页"]').click());
    assert.deepEqual(pages, [2]);
    await act(async () => render([{ database: "state_5.sqlite", available: false, error: "说明数据库缺失" }, sources[0]]));
    assert.match(info.textContent, /说明数据库缺失/);
    assert.equal(history.querySelectorAll(".event-card").length, 3);
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, value] of original) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
  }
});
