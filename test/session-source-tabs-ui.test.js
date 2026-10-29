import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("会话来源 Tab 默认展示 JSONL、状态独立并保留隐藏面板内容和滚动位置", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
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
    const { SessionSourceTabs } = await vite.ssrLoadModule("/src/components/SessionSourceTabs.jsx");
    const host = window.document.createElement("div");
    const scrollPanel = window.document.createElement("div");
    scrollPanel.className = "session-tab-panel";
    host.append(scrollPanel);
    window.document.body.append(host);
    root = createRoot(scrollPanel);

    function Counter({ label }) {
      const [count, setCount] = useState(0);
      return React.createElement("button", { type: "button", onClick: () => setCount((value) => value + 1) }, `${label} ${count}`);
    }

    function sourceTabs(label, active = true) {
      return React.createElement(SessionSourceTabs, {
        active,
        jsonl: (jsonlActive) => React.createElement("output", { "data-source": `${label}-jsonl`, "data-active": String(jsonlActive) }, `${label} JSONL`),
        sqlite: React.createElement(Counter, { label: `${label} SQLite` }),
      });
    }

    await act(async () => root.render(React.createElement(React.Fragment, null,
      sourceTabs("first"),
      sourceTabs("second", false),
    )));

    const tablists = host.querySelectorAll('[role="tablist"]');
    assert.equal(tablists.length, 2);
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    assert.equal(new Set(tabs.map((tab) => tab.id)).size, 4, "useId keeps source tab ids unique across session panels");
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    assert.equal(tabs[1].getAttribute("aria-selected"), "false");
    assert.equal(host.querySelector('[data-source="first-jsonl"]').getAttribute("data-active"), "true");
    assert.equal(host.querySelector('[data-source="second-jsonl"]').getAttribute("data-active"), "false");

    Object.defineProperty(scrollPanel, "scrollTop", { configurable: true, writable: true, value: 245 });
    await act(async () => tabs[1].click());
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    assert.equal(host.querySelector('[data-source="first-jsonl"]').getAttribute("data-active"), "false");
    assert.equal(host.querySelector('[data-source="first-jsonl"]').closest('[role="tabpanel"]').hidden, true);
    assert.equal(host.querySelector('[role="tabpanel"][aria-labelledby="' + tabs[1].id + '"]').hidden, false);
    assert.equal(scrollPanel.scrollTop, 0, "a new source opens at its own saved position");

    await act(async () => host.querySelector('.session-source-panel:not([hidden]) button').click());
    assert.match(host.textContent, /first SQLite 1/);
    Object.defineProperty(scrollPanel, "scrollTop", { configurable: true, writable: true, value: 80 });

    await act(async () => tabs[0].click());
    assert.equal(scrollPanel.scrollTop, 245, "returning to JSONL restores its previous scroll position");
    assert.equal(host.textContent.includes("first SQLite 1"), true, "the hidden SQLite panel remains mounted");
    assert.equal(tabs[3].getAttribute("aria-selected"), "false", "the second session keeps its own source selection");

    await act(async () => tabs[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    assert.equal(window.document.activeElement, tabs[1]);
    await act(async () => tabs[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    assert.equal(window.document.activeElement, tabs[0]);
    await act(async () => tabs[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    await act(async () => tabs[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
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
