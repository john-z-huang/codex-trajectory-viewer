import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

class TestIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnectCount = 0;
    TestIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  disconnect() {
    this.disconnectCount += 1;
    this.targets.clear();
  }

  report(target, visible) {
    this.callback([{
      target,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
    }]);
  }
}

test("SQLite 对话复用 JSONL 原生原文入口和完整可取消操作组，并跨 history 页定位首尾", async () => {
  TestIntersectionObserver.instances = [];
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const scrollCalls = [];
  const panelRect = { top: 100, bottom: 400, left: 0, right: 600, width: 600, height: 300 };
  const originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  const clipboardWrites = [];
  let clipboardMode = "success";
  let resolveClipboardWrite;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text) {
        clipboardWrites.push(text);
        if (clipboardMode === "failure") return Promise.reject(new Error("synthetic clipboard failure"));
        if (clipboardMode === "pending") return new Promise((resolve) => { resolveClipboardWrite = resolve; });
        return Promise.resolve();
      },
    },
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    IntersectionObserver: TestIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let vite;
  let root;
  let sourceRoot;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
      logLevel: "error",
    });
    const [{ SqliteSupplement }, { SessionSourceTabs }] = await Promise.all([
      vite.ssrLoadModule("/src/components/SqliteSupplement.jsx"),
      vite.ssrLoadModule("/src/components/SessionSourceTabs.jsx"),
    ]);
    const host = window.document.createElement("div");
    host.innerHTML = '<section class="session-tab-panel"></section>';
    window.document.body.append(host);
    const panel = host.firstElementChild;
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1200 });
    panel.scrollTop = 0;
    panel.scrollTo = (options) => scrollCalls.push(options);
    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === panel) return panelRect;
      if (this.classList?.contains("event-meta")) {
        return { top: 130, bottom: 170, left: 0, right: 600, width: 600, height: 40 };
      }
      if (this.classList?.contains("sqlite-history-card")) {
        const top = currentPage === 1 ? 250 : 650;
        return { top, bottom: top + 120, left: 0, right: 600, width: 600, height: 120 };
      }
      return originalGetBoundingClientRect.call(this);
    };
    root = createRoot(panel);

    const longText = `**Rendered SQLite start**\n\n[unsafe](javascript:alert(1))\n\n${"Synthetic passage for a complete readable transcript.\n".repeat(260)}\n![no remote fetch](https://example.invalid/pixel.png)\n\nTAIL_SENTINEL`;
    const rowTwo = {
      item_id: "RAW_METADATA_SECRET_ITEM",
      turn_id: "RAW_METADATA_SECRET_TURN",
      item_type: "userMessage",
      item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text: longText }] }),
    };
    const rowOne = {
      item_id: "synthetic-first-item",
      turn_id: "synthetic-first-turn",
      item_type: "userMessage",
      item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text: "Synthetic first-page content" }] }),
    };
    const rowThree = {
      item_id: "synthetic-last-item",
      turn_id: "synthetic-last-turn",
      item_type: "assistantMessage",
      item_json: JSON.stringify({ type: "agentMessage", content: [{ type: "text", text: "Synthetic last-page content" }] }),
    };
    let currentPage = 2;
    let currentRows = [rowTwo];
    let active = true;
    let historyLoading = false;
    const requestedPages = [];
    const sources = () => [{
      database: "thread_history_1.sqlite",
      available: true,
      tables: [{
        table: "thread_items",
        rows: currentRows,
        pagination: { page: currentPage, pageSize: 1, totalRows: 3, hasMore: currentPage < 3 },
      }],
    }];
    const renderSupplement = () => React.createElement(SqliteSupplement, {
      sources: sources(),
      active,
      historyLoading,
      onLoadHistoryPage: (page) => requestedPages.push(page),
    });
    await act(async () => root.render(renderSupplement()));
    const table = () => panel.querySelector("details.sqlite-table");
    await act(async () => table().querySelector(":scope > summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const card = () => panel.querySelector(".sqlite-history-card");
    const observer = () => TestIntersectionObserver.instances.at(-1);
    await act(async () => observer().report(card(), true));

    const timelineStyle = await readFile(new URL("../src/styles/timeline.css", import.meta.url), "utf8");
    const sqliteStyle = await readFile(new URL("../src/styles/sqlite.css", import.meta.url), "utf8");
    assert.match(timelineStyle, /\.event-body details\s*\{[^}]*border-top:\s*1px solid #f0f0f2/);
    assert.match(timelineStyle, /\.event-body summary\s*\{[^}]*font-size:\s*10px[^}]*color:\s*#8c8e96/);
    assert.match(sqliteStyle, /\.sqlite-table\s*>\s*summary\s*\{/);
    assert.doesNotMatch(sqliteStyle, /\.sqlite-table summary\s*\{/, "outer table title rules do not override the nested raw disclosure");

    const rawDisclosure = () => card().querySelector("details.sqlite-raw-row");
    assert.equal(rawDisclosure().open, false);
    assert.equal(rawDisclosure().querySelector("pre"), null, "raw row text is lazy before disclosure");
    await act(async () => {
      rawDisclosure().querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawDisclosure().open, true, "the native details summary opens the raw row");
    assert.equal(rawDisclosure().querySelector("summary").textContent, "原始 JSON");
    assert.match(rawDisclosure().querySelector(".sqlite-row")?.textContent ?? "", /RAW_METADATA_SECRET_ITEM/);
    await act(async () => rawDisclosure().querySelector(".sqlite-text-pager button:last-child").click());
    const secondRawChunk = rawDisclosure().querySelector(".sqlite-row").textContent;
    await act(async () => {
      rawDisclosure().querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawDisclosure().querySelector("pre"), null, "closing releases the raw chunk DOM");
    await act(async () => {
      rawDisclosure().querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawDisclosure().querySelector(".sqlite-row").textContent, secondRawChunk, "reopening restores the previous raw chunk");

    const refreshedRowTwo = {
      ...rowTwo,
      item_json: JSON.stringify({ type: "userMessage", content: [{ type: "text", text: `**REFRESHED_RAW**\n\n${longText}` }] }),
    };
    currentRows = [refreshedRowTwo];
    await act(async () => root.render(renderSupplement()));
    assert.match(rawDisclosure().querySelector(".sqlite-row")?.textContent ?? "", /REFRESHED_RAW/);
    assert.match(rawDisclosure().querySelector(".sqlite-text-pager")?.textContent ?? "", /第 1 \/ /, "a refreshed row resets its raw offset");
    await act(async () => observer().report(card(), true));

    const controls = () => card().querySelector(".event-controls");
    assert.equal(controls().getAttribute("aria-hidden"), "false");
    assert.deepEqual([...controls().querySelectorAll("button")].map((button) => button.textContent), ["复制对话", "收起对话", "↑", "↓"]);
    assert.equal(card().querySelectorAll("img").length, 0, "Markdown image content does not request remote assets");
    assert.equal(card().querySelector('a[href^="javascript:"]'), null, "unsafe Markdown URL schemes are discarded");

    const copyButton = controls().querySelector('[aria-label="复制对话"]');
    await act(async () => {
      copyButton.click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.match(clipboardWrites.at(-1) ?? "", /Rendered SQLite start/);
    assert.match(clipboardWrites.at(-1) ?? "", /TAIL_SENTINEL/, "copy includes the full Markdown tail beyond the visible fragment");
    assert.doesNotMatch(clipboardWrites.at(-1) ?? "", /RAW_METADATA_SECRET_(?:ITEM|TURN)|复制对话|原始 JSON|第 1 \/ \d+ 段/);
    assert.doesNotMatch(clipboardWrites.at(-1) ?? "", /javascript:alert/);
    assert.equal(controls().querySelector('[role="status"]')?.textContent, "已复制");

    await act(async () => card().querySelector(".event-content .sqlite-text-pager button:last-child").click());
    const bodyTail = card().querySelector(".event-content").textContent;
    assert.match(bodyTail, /TAIL_SENTINEL/);
    await act(async () => rawDisclosure().querySelector(".sqlite-text-pager button:last-child").click());
    await act(async () => card().querySelector('[aria-label^="收起第 1 条 SQLite 对话"]').click());
    assert.ok(card().querySelector(".event-body").classList.contains("collapsed"));
    assert.ok(card().querySelector(".event-body").classList.contains("collapse-highlight"));
    assert.equal(card().querySelector(".event-content"), null);
    assert.equal(card().querySelector(".sqlite-row"), null, "collapse closes and unloads raw JSON");
    await act(async () => card().querySelector('[aria-label^="展开第 1 条 SQLite 对话"]').click());
    assert.match(card().querySelector(".event-content")?.textContent ?? "", /TAIL_SENTINEL/, "expanded content returns to its previous fragment");
    await act(async () => {
      rawDisclosure().querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawDisclosure().querySelector(".sqlite-text-pager")?.textContent.includes("第 2 /"), true, "collapse preserves the raw fragment position while keeping it closed");

    clipboardMode = "pending";
    await act(async () => controls().querySelector('[aria-label="复制对话"]').click());
    assert.equal(controls().querySelector('[aria-label="取消复制"]')?.textContent, "取消");
    await act(async () => controls().querySelector('[aria-label="取消复制"]').click());
    assert.equal(controls().querySelector('[role="status"]')?.textContent, "已取消复制");
    resolveClipboardWrite?.();
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(controls().querySelector('[role="status"]')?.textContent, "已取消复制", "late clipboard completion cannot overwrite cancellation");
    clipboardMode = "failure";
    await act(async () => {
      controls().querySelector('[aria-label="复制对话"]').click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(controls().querySelector('[role="status"]')?.textContent, "复制失败");
    clipboardMode = "success";

    const firstButton = () => card().querySelector('[data-timeline-action="first"]');
    const lastButton = () => card().querySelector('[data-timeline-action="last"]');
    const initialScrollCount = scrollCalls.length;
    await act(async () => firstButton().click());
    assert.deepEqual(requestedPages, [1]);
    historyLoading = true;
    await act(async () => root.render(renderSupplement()));
    currentPage = 1;
    currentRows = [rowOne];
    historyLoading = false;
    await act(async () => root.render(renderSupplement()));
    assert.equal(panel.querySelector(".sqlite-history-card").dataset.sqliteId, "synthetic-first-item");
    assert.equal(window.document.activeElement, panel.querySelector(".sqlite-history-card"), "the first target receives focus after its page renders");
    assert.equal(scrollCalls.at(-1)?.top, 150, "first navigation aligns the target to the top of the session panel");
    assert.ok(scrollCalls.length > initialScrollCount);

    await act(async () => observer().report(card(), true));
    await act(async () => lastButton().click());
    assert.deepEqual(requestedPages, [1, 3], "last navigation requests the final history page, not the current page edge");
    historyLoading = true;
    await act(async () => root.render(renderSupplement()));
    active = false;
    currentPage = 3;
    currentRows = [rowThree];
    historyLoading = false;
    const scrollCountWhileHidden = scrollCalls.length;
    await act(async () => root.render(renderSupplement()));
    assert.equal(scrollCalls.length, scrollCountWhileHidden, "a delayed page response cannot navigate while the SQLite source is hidden");
    assert.equal(panel.querySelector(".event-controls")?.getAttribute("aria-hidden"), "true");
    active = true;
    await act(async () => root.render(renderSupplement()));
    assert.equal(panel.querySelector(".sqlite-history-card").dataset.sqliteId, "synthetic-last-item");
    assert.equal(window.document.activeElement, panel.querySelector(".sqlite-history-card"), "pending navigation completes after the source becomes active");
    assert.equal(scrollCalls.at(-1)?.top, 370, "last navigation aligns the target to the bottom of the session panel");

    currentPage = 2;
    currentRows = [refreshedRowTwo];
    await act(async () => root.render(renderSupplement()));
    await act(async () => observer().report(card(), true));
    await act(async () => firstButton().click());
    historyLoading = true;
    await act(async () => root.render(renderSupplement()));
    historyLoading = false;
    await act(async () => root.render(renderSupplement()));
    assert.match(panel.querySelector(".sqlite-navigation-status")?.textContent ?? "", /读取失败/, "failed page requests produce a visible navigation status");

    currentPage = 2;
    currentRows = [refreshedRowTwo];
    await act(async () => root.render(renderSupplement()));
    await act(async () => observer().report(card(), true));
    await act(async () => lastButton().click());
    historyLoading = true;
    await act(async () => root.render(renderSupplement()));
    currentPage = 3;
    currentRows = [];
    historyLoading = false;
    await act(async () => root.render(renderSupplement()));
    assert.match(panel.querySelector(".sqlite-navigation-status")?.textContent ?? "", /没有可显示的记录/, "an empty destination page reports failure without scrolling or focusing a missing row");

    currentPage = 2;
    currentRows = [refreshedRowTwo];
    await act(async () => root.render(renderSupplement()));
    await act(async () => observer().report(card(), true));
    clipboardMode = "pending";
    await act(async () => card().querySelector('[aria-label="复制对话"]').click());
    assert.ok(resolveClipboardWrite, "a pending local clipboard write is available to cancel or outlive the card");
    await act(async () => root.unmount());
    root = null;
    resolveClipboardWrite();
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
    assert.equal(window.document.body.querySelector(".event-copy-source"), null, "unmount removes the full-content copy portal");
    clipboardMode = "success";

    const sourceHost = window.document.createElement("div");
    window.document.body.append(sourceHost);
    sourceRoot = createRoot(sourceHost);
    const activeValues = [];
    const renderTabs = (outerActive) => React.createElement(SessionSourceTabs, {
      active: outerActive,
      jsonl: React.createElement("div", null, "JSONL"),
      sqlite: (sqliteActive) => {
        activeValues.push(sqliteActive);
        return React.createElement("div", null, "SQLite");
      },
    });
    await act(async () => sourceRoot.render(renderTabs(true)));
    assert.equal(activeValues.at(-1), false, "SQLite actions start inactive while JSONL is selected");
    await act(async () => sourceHost.querySelectorAll('[role="tab"]')[1].click());
    assert.equal(activeValues.at(-1), true, "the selected SQLite source receives the active flag");
    await act(async () => sourceRoot.render(renderTabs(false)));
    assert.equal(activeValues.at(-1), false, "an inactive outer session disables SQLite actions");
  } finally {
    if (root) await act(async () => root.unmount());
    if (sourceRoot) await act(async () => sourceRoot.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
