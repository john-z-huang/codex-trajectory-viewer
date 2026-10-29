import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createServer } from "vite";

function makeSession(id, title, cwd, updatedAt) {
  return { id, title, cwd, updatedAt };
}

function setInputValue(input, value, window) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("SessionSearch 搜索项目与会话、打开选中项、刷新并在 sessions 更新时保留 query", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
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
  const { createRoot } = await import("react-dom/client");

  let vite;
  let root;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { SessionSearch } = await vite.ssrLoadModule("/src/components/SessionSearch.jsx");
    const host = window.document.createElement("div");
    window.document.body.append(host);
    root = createRoot(host);

    const sessions = [
      makeSession("alpha-selected", "Alpha conversation", "/projects/alpha", "2026-10-29T00:00:03Z"),
      makeSession("alpha-other", "Alpha background task", "/projects/alpha", "2026-10-29T00:00:02Z"),
      makeSession("beta-session", "Beta conversation", "/projects/beta", "2026-10-29T00:00:01Z"),
    ];
    let currentSessions = sessions;
    let loading = false;
    const openedSessions = [];
    let refreshCalls = 0;
    const render = () => root.render(React.createElement(SessionSearch, {
      sessions: currentSessions,
      activeSessionId: "alpha-selected",
      onOpenSession: (id) => openedSessions.push(id),
      onRefresh: () => { refreshCalls += 1; },
      loading,
    }));

    await act(async () => render());
    const searchInput = host.querySelector(".search-box input");
    const sessionList = host.querySelector(".session-list");
    const refreshButton = host.querySelector('[aria-label="刷新会话"]');
    assert.ok(searchInput);
    assert.ok(sessionList);

    await act(async () => setInputValue(searchInput, "beta", window));
    assert.equal(searchInput.value, "beta");
    assert.deepEqual([...sessionList.querySelectorAll(".session-item strong")].map((node) => node.textContent), ["Beta conversation"]);
    assert.deepEqual([...sessionList.querySelectorAll(".project-heading strong")].map((node) => node.textContent), ["beta"]);

    await act(async () => setInputValue(searchInput, "does-not-exist", window));
    assert.equal(sessionList.querySelectorAll(".session-item").length, 0);
    assert.match(sessionList.querySelector(".empty-list")?.textContent ?? "", /没有匹配的项目或会话/);

    await act(async () => setInputValue(searchInput, "needle", window));
    currentSessions = [
      ...sessions,
      makeSession("alpha-needle-added", "Needle follow-up", "/projects/alpha", "2026-10-29T00:00:04Z"),
    ];
    await act(async () => render());
    assert.equal(searchInput.value, "needle", "updating sessions preserves the component-owned query");
    assert.deepEqual([...sessionList.querySelectorAll(".session-item strong")].map((node) => node.textContent), ["Needle follow-up"]);

    await act(async () => setInputValue(searchInput, "Alpha conversation", window));
    const selected = sessionList.querySelector('[data-sidebar-key="session:alpha-selected"]');
    assert.ok(selected);
    assert.equal(selected.classList.contains("active"), true);
    assert.equal(selected.getAttribute("aria-current"), "page");
    await act(async () => selected.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(openedSessions, ["alpha-selected"]);

    await act(async () => refreshButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(refreshCalls, 1);
    loading = true;
    await act(async () => render());
    assert.equal(refreshButton.disabled, true);
    await act(async () => refreshButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(refreshCalls, 1, "disabled refresh does not invoke its callback");
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
