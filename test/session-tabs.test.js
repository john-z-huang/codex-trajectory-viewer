import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createEmptySessionTabs, sessionTabsReducer } from "../src/lib/session-tabs.js";

test("opening a session creates and activates a new tab without replacing prior tabs", () => {
  let state = createEmptySessionTabs();
  state = sessionTabsReducer(state, { type: "open", id: "tab-a", sessionId: "session-a" });
  const firstTab = state.tabs[0];
  state = sessionTabsReducer(state, { type: "open", id: "tab-b", sessionId: "session-b" });

  assert.deepEqual(state.tabs, [firstTab, { id: "tab-b", sessionId: "session-b" }]);
  assert.equal(state.activeTabId, "tab-b");
});

test("opening an existing session reactivates its original tab and activation ignores unknown ids", () => {
  let state = createEmptySessionTabs();
  state = sessionTabsReducer(state, { type: "open", id: "tab-a", sessionId: "session-a" });
  const firstTab = state.tabs[0];
  state = sessionTabsReducer(state, { type: "open", id: "tab-b", sessionId: "session-b" });
  const afterSecondOpen = state;
  state = sessionTabsReducer(state, { type: "open", id: "tab-new", sessionId: "session-a" });
  assert.deepEqual(state, { tabs: afterSecondOpen.tabs, activeTabId: "tab-a" });
  assert.deepEqual(state.tabs, [firstTab, { id: "tab-b", sessionId: "session-b" }]);
  assert.equal(sessionTabsReducer(state, { type: "open", id: "tab-another", sessionId: "session-a" }), state);
  assert.equal(sessionTabsReducer(state, { type: "open", id: "tab-invalid", sessionId: " " }), state);
  const beforeUnknownActivation = state;
  state = sessionTabsReducer(state, { type: "activate", id: "missing" });

  assert.equal(state, beforeUnknownActivation);
  assert.deepEqual(state.tabs.map((tab) => tab.sessionId), ["session-a", "session-b"]);
  assert.equal(state.activeTabId, "tab-a");
});

test("closing a non-active tab preserves the selected tab", () => {
  let state = createEmptySessionTabs();
  state = sessionTabsReducer(state, { type: "open", id: "tab-a", sessionId: "session-a" });
  state = sessionTabsReducer(state, { type: "open", id: "tab-b", sessionId: "session-b" });
  state = sessionTabsReducer(state, { type: "close", id: "tab-a" });

  assert.deepEqual(state.tabs, [{ id: "tab-b", sessionId: "session-b" }]);
  assert.equal(state.activeTabId, "tab-b");
});

test("closing the active tab selects a neighbor and closing the last tab returns to the empty state", () => {
  let state = createEmptySessionTabs();
  state = sessionTabsReducer(state, { type: "open", id: "tab-a", sessionId: "session-a" });
  state = sessionTabsReducer(state, { type: "open", id: "tab-b", sessionId: "session-b" });
  state = sessionTabsReducer(state, { type: "open", id: "tab-c", sessionId: "session-c" });
  state = sessionTabsReducer(state, { type: "close", id: "tab-c" });
  assert.equal(state.activeTabId, "tab-b");

  state = sessionTabsReducer(state, { type: "close", id: "tab-b" });
  assert.equal(state.activeTabId, "tab-a");
  state = sessionTabsReducer(state, { type: "close", id: "tab-a" });
  assert.deepEqual(state, createEmptySessionTabs());
});

test("sidebar and open session panels own separate vertical scroll areas", async () => {
  const entry = new URL("../src/style.css", import.meta.url);
  const stylesheet = await readFile(entry, "utf8");
  const imports = [...stylesheet.matchAll(/@import\s+["'](.+?)["'];/g)];
  const css = (await Promise.all(imports.map(([, path]) => readFile(new URL(path, entry), "utf8")))).join("\n");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarationsFor = (selector) => rules
    .filter(([, selectors]) => selectors.trim().split(",").some((item) => item.trim() === selector))
    .map(([, , declarations]) => declarations)
    .join(";");

  assert.match(declarationsFor("body"), /overflow:\s*hidden/);
  assert.match(declarationsFor(".app-shell"), /height:\s*100dvh/);
  assert.match(declarationsFor(".session-list"), /overflow-y:\s*auto/);
  assert.match(declarationsFor(".session-tab-panel"), /overflow-y:\s*auto/);
  assert.match(declarationsFor(".session-tab-panel[hidden]"), /display:\s*none/);
});
