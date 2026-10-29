import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function makeEntries(startLine, pageSize) {
  return Array.from({ length: pageSize }, (_, offset) => ({
    lineNumber: startLine + offset,
    timestamp: "2026-10-29T00:00:00Z",
    kind: "user",
    title: `Synthetic line ${startLine + offset}`,
    text: `Synthetic content ${startLine + offset}`,
    originalLocator: { revision: "synthetic-revision" },
  }));
}

test("上下时间线工具栏共享分页状态和导航，底部按钮可翻页且表单 ID 唯一", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
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
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { Timeline } = await vite.ssrLoadModule("/src/components/Timeline.jsx");
    const panel = window.document.createElement("section");
    panel.className = "session-tab-panel";
    window.document.body.append(panel);
    root = createRoot(panel);

    const requestedLines = [];
    const renderPage = (startLine, { pageLoading = false, searchLoading = false } = {}) => {
      root.render(React.createElement(Timeline, {
        entries: makeEntries(startLine, 32),
        sessionId: "synthetic-session",
        active: false,
        rollout: { revision: "synthetic-revision", totalLines: 64, pageSize: 32, startLine },
        pageLoading,
        searchLoading,
        onNavigateLine: (lineNumber) => requestedLines.push(lineNumber),
      }));
    };
    const toolbars = () => [...panel.querySelectorAll(".timeline-label.timeline-toolbar")];

    await act(async () => renderPage(1));
    let [topToolbar, bottomToolbar] = toolbars();
    assert.equal(toolbars().length, 2);
    assert.equal(panel.querySelector(".virtual-timeline").nextElementSibling, bottomToolbar, "bottom toolbar sits outside and immediately after the virtual list");
    assert.equal(topToolbar.querySelector(".timeline-heading span").textContent, "按 JSONL 物理行顺序 · 64 行 · 第 1 / 2 页");
    assert.equal(bottomToolbar.querySelector(".timeline-heading span").textContent, topToolbar.querySelector(".timeline-heading span").textContent);

    const inputIds = [];
    for (const toolbar of toolbars()) {
      for (const formSelector of [".timeline-jump", ".timeline-find"]) {
        const form = toolbar.querySelector(formSelector);
        const label = form.querySelector("label");
        const input = form.querySelector("input");
        assert.ok(input.id);
        assert.equal(label.htmlFor, input.id, "each toolbar label points to its own input");
        inputIds.push(input.id);
      }
    }
    assert.equal(new Set(inputIds).size, 4, "both bars have unique jump and find input IDs");

    for (const toolbar of toolbars()) {
      assert.equal(toolbar.querySelector('[aria-label="上一页"]').disabled, true, "previous is disabled on the first page");
      assert.equal(toolbar.querySelector('[aria-label="下一页"]').disabled, false, "next is enabled on the first page");
    }
    await act(async () => bottomToolbar.querySelector('[aria-label="下一页"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(requestedLines, [33], "the bottom next button requests the first line of the next page");

    await act(async () => renderPage(33));
    [topToolbar, bottomToolbar] = toolbars();
    assert.equal(topToolbar.querySelector(".timeline-heading span").textContent, "按 JSONL 物理行顺序 · 64 行 · 第 2 / 2 页");
    assert.equal(bottomToolbar.querySelector(".timeline-heading span").textContent, topToolbar.querySelector(".timeline-heading span").textContent);
    for (const toolbar of toolbars()) {
      assert.equal(toolbar.querySelector('[aria-label="上一页"]').disabled, false, "previous is enabled on the last page");
      assert.equal(toolbar.querySelector('[aria-label="下一页"]').disabled, true, "next is disabled on the last page");
    }
    await act(async () => bottomToolbar.querySelector('[aria-label="上一页"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(requestedLines, [33, 1], "the bottom previous button requests the first page");

    await act(async () => renderPage(33, { pageLoading: true, searchLoading: true }));
    for (const toolbar of toolbars()) {
      for (const label of ["回到会话开始处", "上一页", "下一页", "跳转到会话末尾"]) {
        assert.equal(toolbar.querySelector(`[aria-label="${label}"]`).disabled, true, `${label} is disabled while the page loads`);
      }
      assert.equal(toolbar.querySelector(".timeline-jump button[type=submit]").disabled, true);
      assert.equal(toolbar.querySelector(".timeline-find button[type=submit]").disabled, true);
    }
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
