import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const sessions = [
  { id: "session-a", title: "Session A", preview: "First session", cwd: "/project", updatedAt: "2026-10-15T00:00:00Z" },
  { id: "session-b", title: "Session B", preview: "Second session", cwd: "/project", updatedAt: "2026-10-14T00:00:00Z" },
  ...Array.from({ length: 48 }, (_, index) => ({
    id: `session-extra-${index}`,
    title: `Additional Session ${index}`,
    preview: `Additional preview ${index}`,
    cwd: "/project",
    updatedAt: "2026-10-13T00:00:00Z",
  })),
];
const longTimeline = Array.from({ length: 120 }, (_, index) => JSON.stringify({
  timestamp: `2026-10-15T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Synthetic message ${index}` }] },
})).join("\n");

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

test("sidebar selection opens a new mounted tab and restores each tab's reading position", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  original.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/sessions") return jsonResponse(sessions);
    const sessionId = decodeURIComponent(url.pathname.split("/").at(-1));
    const session = sessions.find((item) => item.id === sessionId);
    return session ? jsonResponse({ ...session, filename: `${sessionId}.jsonl`, contents: longTimeline, supplement: [] }) : { ok: false, status: 404 };
  };

  let vite;
  let root;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { SessionViewer } = await vite.ssrLoadModule("/src/main.jsx");
    const rootElement = window.document.createElement("div");
    window.document.body.append(rootElement);
    root = createRoot(rootElement);

    await act(async () => {
      root.render(React.createElement(React.StrictMode, null, React.createElement(SessionViewer)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const firstPanel = rootElement.querySelector('[role="tabpanel"]');
    assert.ok(firstPanel);
    assert.equal(rootElement.querySelectorAll('[role="tab"]').length, 1);
    assert.equal(rootElement.querySelectorAll(".session-list .session-item").length, sessions.length);
    assert.equal(firstPanel.querySelectorAll(".event-card").length, 120);
    firstPanel.scrollTop = 420;
    const sidebar = rootElement.querySelector(".session-list");
    sidebar.scrollTop = 180;

    const secondSessionButton = rootElement.querySelector('[aria-label="在新标签页打开：Session B"]');
    assert.ok(secondSessionButton);
    await act(async () => {
      secondSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const panels = [...rootElement.querySelectorAll('[role="tabpanel"]')];
    assert.equal(panels.length, 2);
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[0].scrollTop, 420);
    assert.equal(panels[1].querySelectorAll(".event-card").length, 120);
    assert.equal(panels[1].hidden, false);
    assert.equal(sidebar.scrollTop, 180);

    const firstTab = [...rootElement.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("Session A"));
    assert.ok(firstTab);
    await act(async () => {
      firstTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[0].scrollTop, 420);
    assert.equal(panels[1].hidden, true);

    const closeSecondTab = rootElement.querySelector('[aria-label="关闭会话标签：Session B"]');
    await act(async () => {
      closeSecondTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]').length, 1);
    assert.equal(rootElement.querySelector('[role="tab"]').getAttribute("aria-selected"), "true");
    assert.equal(rootElement.querySelector('[role="tabpanel"]').scrollTop, 420);

    await act(async () => {
      secondSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const activeTabClose = rootElement.querySelector('[aria-label="关闭会话标签：Session B"]');
    await act(async () => {
      activeTabClose.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]').length, 1);
    assert.equal(rootElement.querySelector('[role="tab"]').textContent, "Session A");
    assert.equal(rootElement.querySelector('[role="tabpanel"]').scrollTop, 420);

    const closeLastTab = rootElement.querySelector('[aria-label="关闭会话标签：Session A"]');
    await act(async () => {
      closeLastTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]').length, 0);
    assert.match(rootElement.querySelector(".welcome h1").textContent, /选择一个会话/);
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
