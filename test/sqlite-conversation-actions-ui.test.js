import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("SQLite 实际复用 JSONL 卡片的分段、完整复制取消、原文、阅读缓存及首尾跨页导航", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const copied = [];
  let mode = "success";
  let resolveCopy;
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText(text) {
    copied.push(text);
    if (mode === "pending") return new Promise((resolve) => { resolveCopy = resolve; });
    if (mode === "failure") return Promise.reject(new Error("synthetic failure"));
    return Promise.resolve();
  } } });
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  let vite;
  try {
    vite = await createServer({ configFile: new URL("../vite.config.js", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
    const { SqliteSupplement } = await vite.ssrLoadModule("/src/components/SqliteSupplement.jsx");
    const panel = window.document.createElement("section");
    panel.className = "session-tab-panel";
    Object.defineProperty(panel, "clientHeight", { value: 1000 });
    Object.defineProperty(panel, "scrollHeight", { value: 6000 });
    panel.getBoundingClientRect = () => ({ top: 0, bottom: 1000, height: 1000 });
    const scrolls = [];
    panel.scrollTo = (value) => { panel.scrollTop = value.top; scrolls.push(value); };
    window.document.body.append(panel);
    root = createRoot(panel);
    const body = `**Rendered SQLite start**\n\n[unsafe](javascript:alert(1))\n\n${"Synthetic complete passage. 😀\n".repeat(6000)}\n![no fetch](https://example.invalid/pixel)\n\nTAIL_SENTINEL`;
    const row = { item_id: "RAW_METADATA_SECRET", item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text: body }] }) };
    const shortRow = (text) => ({ item_json: JSON.stringify({ type: "agentMessage", text }) });
    let page = 2;
    let rows = [row];
    let active = true;
    let loading = false;
    let revision = "sqlite-v1";
    const requested = [];
    const render = () => root.render(React.createElement(SqliteSupplement, {
      sources: [{ database: "thread_history_1.sqlite", available: true, tables: [{ table: "thread_items", rows, pagination: { page, pageSize: 1, totalRows: 3, hasMore: page < 3 } }] }],
      active, revision, historyLoading: loading, onLoadHistoryPage: (next) => requested.push(next),
    }));
    const card = () => panel.querySelector(".sqlite-conversation .event-card");
    const click = async (node) => { assert.ok(node); await act(async () => { node.click(); await new Promise((resolve) => setTimeout(resolve, 0)); }); };
    await act(async () => render());
    assert.equal(card().dataset.lineNumber, "2");
    assert.equal(card().querySelectorAll(".event-controls").length, 1);
    assert.ok(card().querySelector(".event-text-fragment").textContent.length <= 16385);
    assert.equal(card().querySelector("img"), null);
    const raw = () => card().querySelector("details");
    assert.equal(raw().querySelector("pre"), null);
    await click(raw().querySelector("summary"));
    const parts = [raw().querySelector(".event-raw-view > pre").textContent];
    const nextRaw = () => [...raw().querySelectorAll("button")].find((node) => node.textContent === "下一片");
    while (!nextRaw().disabled) {
      await click(nextRaw());
      parts.push(raw().querySelector(".event-raw-view > pre").textContent);
    }
    assert.equal(parts.join(""), JSON.stringify(row, null, 2));
    assert.equal(raw().querySelector("a[download]").getAttribute("href").startsWith("blob:"), true);
    const lastChunk = parts.at(-1);
    await click(raw().querySelector("summary"));
    assert.equal(raw().querySelector("pre"), null);
    await click(raw().querySelector("summary"));
    assert.equal(raw().querySelector(".event-raw-view > pre").textContent, lastChunk);
    await click(card().querySelector('[aria-label="复制对话"]'));
    assert.match(copied.at(-1), /Rendered SQLite start/);
    assert.match(copied.at(-1), /TAIL_SENTINEL/);
    assert.doesNotMatch(copied.at(-1), /RAW_METADATA_SECRET|javascript:alert|原始 JSON/);
    assert.equal(card().querySelector(".event-copy-status").textContent, "已复制");
    mode = "pending";
    await click(card().querySelector('[aria-label="复制对话"]'));
    await click(card().querySelector('[aria-label="取消复制"]'));
    resolveCopy();
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(card().querySelector(".event-copy-status").textContent, "已取消复制");
    mode = "failure";
    await click(card().querySelector('[aria-label="复制对话"]'));
    assert.equal(card().querySelector(".event-copy-status").textContent, "复制失败");
    mode = "success";
    await click(card().querySelector('.event-content [aria-label="查看下一段"]'));
    const bodyChunk = card().querySelector(".event-text-fragment").textContent;
    await click(card().querySelector('[aria-label="收起第 2 条 SQLite 对象"]'));
    assert.equal(card().querySelector(".event-content"), null);
    assert.equal(raw(), null);
    await click(card().querySelector('[aria-label="展开第 2 条 SQLite 对象"]'));
    assert.equal(card().querySelector(".event-text-fragment").textContent, bodyChunk);
    await click(raw().querySelector("summary"));
    assert.equal(raw().querySelector(".event-raw-view > pre").textContent, lastChunk);
    await click(card().querySelector('[data-timeline-action="first"]'));
    assert.deepEqual(requested, [1]);
    loading = true;
    await act(async () => render());
    page = 1; rows = [shortRow("first")]; loading = false;
    await act(async () => { render(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(window.document.activeElement, card());
    await click(card().querySelector('[data-timeline-action="last"]'));
    assert.deepEqual(requested, [1, 3]);
    loading = true; active = false;
    await act(async () => render());
    const scrollCount = scrolls.length;
    page = 3; rows = [shortRow("last")]; loading = false;
    await act(async () => render());
    assert.equal(scrolls.length, scrollCount, "hidden completion does not scroll");
    active = true;
    await act(async () => { render(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(window.document.activeElement, card());
    page = 2; rows = [row];
    await act(async () => render());
    assert.equal(card().querySelector(".event-text-fragment").textContent, bodyChunk);
    assert.equal(raw().open, true);
    assert.equal(raw().querySelector(".event-raw-view > pre").textContent, lastChunk);
    revision = "sqlite-v2";
    rows = [{ ...row, refreshed: "NEW_REVISION" }];
    await act(async () => render());
    assert.match(raw().querySelector(".event-raw-toolbar").textContent, /^0–/);
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, value] of original) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
  }
});
