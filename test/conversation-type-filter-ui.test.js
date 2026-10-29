import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { projectRolloutLines } from "../src/lib/rollout.js";

test("两来源按各自类型筛选，保持独立选择、物理分页、稳定索引和隐藏行提示", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
      server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error",
    });
    const { SessionDetail } = await vite.ssrLoadModule("/src/components/SessionDetail.jsx");
    const host = window.document.createElement("section");
    host.className = "session-tab-panel";
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 20000 });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 20000, left: 0, right: 1000, width: 1000, height: 20000 });
    host.scrollTo = () => {};
    window.document.body.append(host);
    root = createRoot(host);

    let page = 1;
    let eventEntries = null;
    const navigatedLines = [];
    const historyPages = [];
    const kinds = ["user", "tool-call", "assistant", "event", "metadata", "invalid", "empty", "oversized", "future-kind", "tool-result"];
    const rowTypes = ["userMessage", "agentMessage", "reasoning", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "functionCallOutput", "future-item"];
    const rows = rowTypes.map((type, index) => ({
      item_id: `synthetic-item-${index}`,
      item_type: type,
      item_json: JSON.stringify({ type, text: `Synthetic SQLite ${index}`, content: [], summary: [], output: "Synthetic tool output" }),
    }));
    const render = () => root.render(React.createElement(React.Fragment, null,
      ...["first", "second"].map((id) => React.createElement(SessionDetail, {
        key: id,
        detail: {
          id, title: `Synthetic ${id}`, filename: "synthetic.jsonl",
          supplement: [{ database: "synthetic.sqlite", available: true, tables: [
            { table: "threads", rows: [{ thread_id: id, title: "metadata remains accessible" }] },
            { table: "thread_items", rows: page === 1 ? rows : [rows[0]], pagination: { page, pageSize: 9, totalRows: 10, hasMore: page === 1 } },
          ] }],
        },
        timeline: eventEntries ?? (page === 1 ? kinds : ["tool-call"]).map((kind, index) => ({
          lineNumber: page === 1 ? index + 1 : 11,
          kind, title: `Synthetic JSONL ${kind}`, text: `Synthetic text ${index}`,
        })),
        rollout: { revision: "synthetic-revision", startLine: page === 1 ? 1 : 11, totalLines: 11, pageSize: 10 },
        onNavigateLine: (line) => navigatedLines.push(line),
        onSearch: async () => 2,
        onLoadHistoryPage: (next) => historyPages.push(next),
      })),
    ));
    const click = async (element) => {
      assert.ok(element, "synthetic UI control exists");
      await act(async () => element.click());
    };
    const sourceGroups = () => [...host.querySelectorAll(".session-source-tabs")];
    const jsonl = () => sourceGroups()[0].querySelector(".session-source-panel");
    const sqlite = () => sourceGroups()[0].querySelectorAll(".session-source-panel")[1];
    const filterInput = (container, label) => [...container.querySelectorAll(".conversation-type-filter label")]
      .find((node) => node.textContent === label)?.querySelector("input");
    const filterButton = (container, label) => [...container.querySelectorAll(".conversation-type-filter button")]
      .find((node) => node.textContent === label);
    const cards = () => [...jsonl().querySelectorAll(".event-card")];

    await act(async () => render());
    assert.equal(cards().length, 10, "all actual and unknown JSONL kinds are initially visible");
    await click(filterInput(jsonl(), "工具调用"));
    assert.deepEqual(cards().map((card) => Number(card.dataset.lineNumber)), [1, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok([...jsonl().querySelectorAll(".conversation-type-filter label")].filter((node) => node.textContent === "工具调用").every((node) => !node.querySelector("input").checked), "top and bottom parent filters stay synchronized");
    assert.equal(sourceGroups()[1].querySelectorAll(".event-card").length, 10, "another session keeps its own filter");
    cards()[0].focus();
    await act(async () => cards()[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(window.document.activeElement.dataset.lineNumber, "3", "keyboard navigation skips hidden records");

    const jumpForm = jsonl().querySelector(".timeline-jump");
    jumpForm.querySelector("input").value = "2";
    await act(async () => jumpForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.match(jsonl().textContent, /第 2 行已被类型筛选隐藏/);
    assert.deepEqual(navigatedLines, [], "a hidden loaded line never triggers another page fetch");
    const findForm = jsonl().querySelector(".timeline-find");
    findForm.querySelector("input").value = "synthetic";
    await act(async () => findForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.match(jsonl().textContent, /第 2 行已被类型筛选隐藏/);

    await click(sourceGroups()[0].querySelectorAll('[role="tab"]')[1]);
    const itemTable = () => sqlite().querySelectorAll("details.sqlite-table")[1];
    await click(itemTable().querySelector("summary"));
    assert.equal(itemTable().querySelectorAll(".sqlite-history-card").length, 9, "JSONL choices do not alter SQLite");
    assert.ok(filterInput(sqlite(), "助手思考"), "SQLite exposes reasoning separately");
    assert.ok(filterInput(sqlite(), "文件变更"), "SQLite exposes file changes separately");
    assert.equal(filterInput(sqlite(), "事件"), undefined);
    await click(filterInput(sqlite(), "用户消息"));
    await click(filterInput(sqlite(), "命令执行"));
    assert.deepEqual([...itemTable().querySelectorAll(".sqlite-history-card")].map((card) => Number(card.dataset.sqliteIndex)), [1, 2, 4, 5, 6, 7, 8]);
    const firstVisible = itemTable().querySelector(".sqlite-history-card");
    await click(firstVisible.querySelector('[aria-label="回到会话开始处"]'));
    assert.equal(window.document.activeElement, firstVisible, "SQLite first action uses the first visible original index");

    await click(sourceGroups()[0].querySelectorAll('[role="tab"]')[0]);
    assert.equal(filterInput(jsonl(), "工具调用").checked, false, "JSONL selection survives source switch");
    assert.equal(filterInput(jsonl(), "用户消息").checked, true, "SQLite user filter stays independent");
    await click(jsonl().querySelector('[aria-label="下一页"]'));
    assert.deepEqual(navigatedLines, [11]);
    page = 2;
    await act(async () => render());
    assert.equal(cards().length, 0, "filters apply to newly loaded pages");
    assert.match(jsonl().textContent, /本页显示 0 \/ 1 条/);
    assert.match(jsonl().textContent, /当前页的记录已全部隐藏/);
    assert.equal(jsonl().querySelector('[aria-label="上一页"]').disabled, false);
    assert.match(jsonl().querySelector(".timeline-heading span").textContent, /11 行 · 第 2 \/ 2 页/);

    await click(sourceGroups()[0].querySelectorAll('[role="tab"]')[1]);
    assert.equal(itemTable().querySelectorAll(".sqlite-history-card").length, 0);
    assert.match(itemTable().textContent, /本页显示 0 \/ 1 条/);
    const previousHistory = [...itemTable().querySelectorAll(".history-pager button")].find((button) => button.textContent === "上一页");
    await click(previousHistory);
    assert.deepEqual(historyPages, [1], "SQLite pagination remains available on a filtered empty page");
    await click(filterButton(sqlite(), "显示全部"));
    assert.equal(itemTable().querySelectorAll(".sqlite-history-card").length, 1);
    await click(filterButton(sqlite(), "隐藏全部"));
    assert.equal(itemTable().querySelectorAll(".sqlite-history-card").length, 0);
    const metadataTable = sqlite().querySelector("details.sqlite-table");
    await click(metadataTable.querySelector("summary"));
    assert.equal(metadataTable.querySelectorAll(".sqlite-history-card").length, 1, "metadata stays accessible with all conversation types hidden");

    await click(sourceGroups()[0].querySelectorAll('[role="tab"]')[0]);
    await click(filterButton(jsonl(), "显示全部"));
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].dataset.lineNumber, "11");
    await click(filterButton(jsonl(), "隐藏全部"));
    assert.equal(cards().length, 0);
    page = 1;
    await act(async () => render());
    assert.equal(cards().length, 0, "hide all also covers types absent on the previous page");
    await click(filterButton(jsonl(), "显示全部"));
    assert.equal(cards().length, 10);

    // Exercise real projected records, including two levels within the event group.
    eventEntries = projectRolloutLines([
      { type: "token_usage_record", payload: { total_tokens: 50 } },
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      { type: "turn_context", payload: {} },
      { type: "compacted", payload: {} },
      { type: "future_event", payload: { title: "Token 用量记录" } },
      { type: "response_item", payload: { type: "function_call", name: "synthetic" } },
    ].map((record, index) => ({ lineNumber: index + 1, raw: JSON.stringify(record) })));
    await act(async () => render());
    const topFilter = () => jsonl().querySelector(".conversation-type-filter");
    const eventParent = () => filterInput(topFilter(), "事件");
    const expandEvents = topFilter().querySelector('[aria-label="展开事件子类别"]');
    assert.equal(expandEvents.getAttribute("aria-expanded"), "false");
    const childrenId = expandEvents.getAttribute("aria-controls");
    assert.equal(window.document.getElementById(childrenId).hidden, true);
    await click(expandEvents);
    assert.equal(window.document.getElementById(childrenId).hidden, false);
    await click(filterInput(topFilter(), "Token 用量记录"));
    assert.deepEqual(cards().map((card) => Number(card.dataset.lineNumber)), [2, 3, 4, 5, 6], "hiding tokens keeps reasoning, other events, and tools visible");
    assert.equal(eventParent().indeterminate, true);
    assert.equal(eventParent().getAttribute("aria-checked"), "mixed");
    const bottomParent = filterInput(jsonl().querySelectorAll(".conversation-type-filter")[1], "事件");
    assert.equal(bottomParent.indeterminate, true, "both toolbar parent states match");
    await click(topFilter().querySelector('[aria-label="展开上下文子类别"]'));
    await click(filterInput(topFilter(), "运行上下文"));
    assert.equal(filterInput(topFilter(), "上下文").indeterminate, true);
    await click(filterInput(topFilter(), "上下文"));
    assert.equal(filterInput(topFilter(), "上下文").checked, true, "clicking a mixed group shows all descendants");
    await click(filterInput(topFilter(), "上下文"));
    assert.deepEqual(cards().map((card) => Number(card.dataset.lineNumber)), [2, 5, 6], "group changes only its own descendants");
    await click(eventParent());
    assert.equal(cards().length, 6, "mixed event parent restores all events");
    await click(eventParent());
    assert.deepEqual(cards().map((card) => Number(card.dataset.lineNumber)), [6], "event parent hides all event subtypes including the unknown fallback");
    eventEntries = projectRolloutLines([{ lineNumber: 11, raw: JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) }]);
    page = 2;
    await act(async () => render());
    assert.equal(cards().length, 0, "parent selection covers later pages and alternate event wrappers");
    await click(filterButton(jsonl(), "显示全部"));
    assert.equal(cards().length, 1);
    await click(filterButton(jsonl(), "隐藏全部"));
    assert.equal(cards().length, 0);

    await click(sourceGroups()[0].querySelectorAll('[role="tab"]')[1]);
    await click(filterButton(sqlite(), "显示全部"));
    page = 1;
    await act(async () => render());
    await click(itemTable().querySelector('[aria-label="展开工具活动子类别"]'));
    await click(itemTable().querySelector('[aria-label="展开工具调用子类别"]'));
    await click(filterInput(sqlite(), "MCP 工具调用"));
    assert.equal(filterInput(sqlite(), "工具调用").indeterminate, true);
    assert.equal(filterInput(sqlite(), "工具活动").indeterminate, true);
    assert.equal(itemTable().querySelector('[data-sqlite-index="5"]'), null);
    assert.ok(itemTable().querySelector('[data-sqlite-index="6"]'), "dynamic tool calls stay visible");
    await click(filterInput(sqlite(), "工具活动"));
    await click(filterInput(sqlite(), "工具活动"));
    assert.deepEqual([...itemTable().querySelectorAll(".sqlite-history-card")].map((card) => Number(card.dataset.sqliteIndex)), [0, 1, 2, 8]);
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
