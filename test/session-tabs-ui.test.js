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

function windowResponse(session, contents = "", supplement = [], subagents = []) {
  const rows = contents ? contents.split("\n") : [];
  const startLine = rows.length ? 1 : 0;
  const pageRows = rows.slice(0, 32).map((raw, index) => ({
    lineNumber: index + 1,
    byteLength: new TextEncoder().encode(raw).byteLength,
    raw,
  }));
  return {
    ...session,
    filename: `${session.id}.jsonl`,
    supplement,
    subagents,
    rollout: {
      revision: `${session.id}-revision`,
      totalLines: rows.length,
      totalBytes: new TextEncoder().encode(contents).byteLength,
      pageSize: 32,
      startLine,
      endLine: pageRows.at(-1)?.lineNumber ?? 0,
      warnings: [],
    },
    lines: pageRows,
  };
}

class TestIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.disconnectCount = 0;
    TestIntersectionObserver.instances.push(this);
  }

  observe() {}
  disconnect() { this.disconnectCount += 1; }
}

test("子代理侧栏、标签和详情标题统一显示规范化 agent_path", async () => {
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
  const instruction = "Please implement the delegated work and report back.";
  const child = {
    id: "child-file",
    sessionId: "child-thread",
    title: "",
    preview: instruction,
    cwd: "/project",
    agent_path: "/root/subagent_classification",
    agent: { parentThreadId: "parent-thread", agentPath: "/root/subagent_classification", nickname: "Franklin" },
    source: JSON.stringify({ subagent: { thread_spawn: { agent_path: "/root/subagent_classification" } } }),
    updatedAt: "2026-10-15T00:00:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/sessions") return jsonResponse([child]);
    return jsonResponse(windowResponse(child));
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
      root.render(React.createElement(SessionViewer));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const displayedTitles = [
      rootElement.querySelector(".session-list .session-copy strong")?.textContent,
      rootElement.querySelector(".session-tab-select")?.textContent,
      rootElement.querySelector(".session-header h1")?.textContent,
    ];
    assert.deepEqual(displayedTitles, ["subagent_classification", "subagent_classification", "subagent_classification"]);
    for (const title of displayedTitles) assert.doesNotMatch(title, /Please implement the delegated work/);
    const sessionButton = rootElement.querySelector(".session-list .session-item");
    const accessibleName = sessionButton?.getAttribute("aria-label") ?? "";
    assert.match(accessibleName, /subagent_classification/);
    assert.doesNotMatch(accessibleName, /Please implement the delegated work/);
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

test("Guardian 会话在侧栏显示 Guardian会话而不显示子代理标签", async () => {
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
  const guardianSession = {
    id: "guardian-session",
    sessionId: "guardian-thread",
    title: "Guardian review",
    preview: "Reviewing changes",
    cwd: "",
    guardian: true,
    agent: null,
    updatedAt: "2026-10-15T00:00:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/sessions") return jsonResponse([guardianSession]);
    return jsonResponse(windowResponse(guardianSession));
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
      root.render(React.createElement(SessionViewer));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = rootElement.querySelector(".session-list .session-item");
    const badge = row?.querySelector(".session-agent-badge");
    const supportingLabel = row?.querySelector(".session-copy small");
    assert.equal(badge?.textContent, "Guardian会话");
    assert.equal(supportingLabel?.textContent, "Guardian会话");
    assert.doesNotMatch(row.textContent, /子代理会话/);
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

test("sidebar selection opens a new mounted tab and restores each tab's reading position", async () => {
  TestIntersectionObserver.instances = [];
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    IntersectionObserver: TestIntersectionObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  original.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));
  const detailRequests = new Map();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/sessions") return jsonResponse(sessions);
    const sessionId = decodeURIComponent(url.pathname.split("/").at(-1));
    const session = sessions.find((item) => item.id === sessionId);
    if (session && url.searchParams.get("view") === "history") {
      return jsonResponse({ supplement: [{
        database: "thread_history_1.sqlite", available: true, tables: [{
          table: "thread_items", rows: [], pagination: { page: Number(url.searchParams.get("historyPage")), totalRows: 100, hasMore: true },
        }],
      }] });
    }
    if (session && url.searchParams.get("view") === "window") {
      detailRequests.set(sessionId, (detailRequests.get(sessionId) || 0) + 1);
      return jsonResponse(windowResponse(session, longTimeline, [{
      database: "thread_history_1.sqlite", available: true, tables: [{
        table: "thread_items", rows: [], pagination: { page: 1, totalRows: 100, hasMore: true },
      }],
    }]));
    }
    return { ok: false, status: 404 };
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
    assert.ok(rootElement.querySelectorAll(".session-list .session-item").length <= 100);
    assert.ok(rootElement.querySelectorAll(".session-list .session-item").length > 0);
    assert.ok(firstPanel.querySelectorAll(".event-card").length <= 100);
    assert.ok(firstPanel.querySelectorAll(".event-card").length > 0);
    const firstEvent = firstPanel.querySelector(".event-card");
    const timelineObserver = TestIntersectionObserver.instances.at(-1);
    assert.ok(timelineObserver);
    await act(async () => timelineObserver.callback([{ target: firstEvent, isIntersecting: true, intersectionRatio: 1 }]));
    const collapseFirstEvent = firstEvent.querySelector('[aria-label="收起第 1 行 JSONL 对象"]');
    assert.ok(collapseFirstEvent);
    await act(async () => collapseFirstEvent.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.ok(firstEvent.querySelector(".event-body").classList.contains("collapsed"));
    const historyTable = firstPanel.querySelector(".sqlite-table");
    await act(async () => historyTable.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const nextHistoryPage = firstPanel.querySelector(".history-pager button:last-child");
    assert.ok(nextHistoryPage);
    await act(async () => {
      nextHistoryPage.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(firstPanel.querySelector(".event-card"), firstEvent);
    assert.equal(TestIntersectionObserver.instances.at(-1), timelineObserver);
    assert.equal(timelineObserver.disconnectCount, 0, "supplement-only paging keeps the timeline observer connected");
    firstPanel.scrollTop = 420;
    const sidebar = rootElement.querySelector(".session-list");
    sidebar.scrollTop = 180;

    const secondSessionButton = rootElement.querySelector('[aria-label="打开会话：Session B"]');
    assert.ok(secondSessionButton);
    await act(async () => {
      secondSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const panels = [...rootElement.querySelectorAll('[role="tabpanel"]')];
    assert.equal(panels.length, 2);
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[0].scrollTop, 420);
    assert.ok(panels[1].querySelectorAll(".event-card").length <= 100);
    assert.ok(panels[1].querySelectorAll(".event-card").length > 0);
    assert.equal(panels[1].hidden, false);
    assert.equal(sidebar.scrollTop, 180);

    const panelIdentities = [...panels];
    const requestsAfterOpen = new Map(detailRequests);
    await act(async () => {
      secondSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]')[1], panelIdentities[1]);
    assert.deepEqual(detailRequests, requestsAfterOpen, "repeatedly opening the active session starts no detail request");

    const firstSessionButton = rootElement.querySelector('[aria-label="打开会话：Session A"]');
    const requestsBeforeBackgroundReuse = new Map(detailRequests);
    await act(async () => {
      firstSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      firstSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]').length, 2);
    assert.equal([...rootElement.querySelectorAll('[role="tab"]')].filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1);
    assert.equal([...rootElement.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent, "Session A");
    assert.equal(rootElement.querySelector('[role="tabpanel"]'), panelIdentities[0]);
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[0].scrollTop, 420);
    assert.ok(panels[0].querySelector(".event-body").classList.contains("collapsed"));
    assert.equal(panels[1].hidden, true);
    assert.deepEqual(detailRequests, requestsBeforeBackgroundReuse, "repeatedly opening a background session starts no detail request");

    const firstTab = [...rootElement.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("Session A"));
    const secondTab = [...rootElement.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("Session B"));
    assert.ok(firstTab && secondTab);
    await act(async () => {
      secondTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(panels[1].hidden, false);
    await act(async () => firstTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[1].hidden, true);

    const closeSecondTab = rootElement.querySelector('[aria-label="关闭会话标签：Session B"]');
    const secondTimelineObserver = [...TestIntersectionObserver.instances].reverse()
      .find((observer) => observer.options.root === panels[1]);
    assert.ok(secondTimelineObserver);
    await act(async () => {
      closeSecondTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(rootElement.querySelectorAll('[role="tabpanel"]').length, 1);
    assert.equal(rootElement.querySelector('[role="tab"]').getAttribute("aria-selected"), "true");
    assert.equal(rootElement.querySelector('[role="tabpanel"]').scrollTop, 420);
    assert.equal(secondTimelineObserver.disconnectCount, 1, "backgrounding a tab disconnects its timeline observer before close");

    const requestsBeforeReopen = detailRequests.get("session-b");
    await act(async () => {
      secondSessionButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const reopenedPanel = rootElement.querySelector('[role="tabpanel"]:not([hidden])');
    assert.notEqual(reopenedPanel, panelIdentities[1], "reopening after close creates a fresh panel instance");
    assert.ok(detailRequests.get("session-b") > requestsBeforeReopen, "reopening after close fetches fresh detail");
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

test("父会话中的子代理入口打开独立标签并呈现子代理身份和完整时间线", async () => {
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
  const sessions = [
    { id: "parent-file", sessionId: "parent-id", title: "Parent session", preview: "Parent", cwd: "/project", timestamp: "2026-10-15T00:00:00Z" },
    { id: "child-file", sessionId: "child-id", title: "Research child", preview: "Child", cwd: "/project", timestamp: "2026-10-15T00:01:00Z", source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent-id", agent_path: "/root/research/worker", agent_role: "explorer" } } }) },
  ];
  let childDetailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/sessions") return jsonResponse(sessions);
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    if (id === "parent-file") return jsonResponse(windowResponse(sessions[0], "", [], [{ ...sessions[1], agent: { parentThreadId: "parent-id", parentSessionId: "parent-file", parentTitle: "Parent session", agentPath: "/root/research/worker", role: "explorer" }, threadId: "child-id", activityStatus: "completed", available: true, reason: null }]));
    if (id === "child-file") {
      childDetailRequests += 1;
      return jsonResponse(windowResponse({ ...sessions[1], agent: { parentThreadId: "parent-id", parentSessionId: "parent-file", parentTitle: "Parent session", agentPath: "/root/research/worker", role: "explorer" } }, JSON.stringify({ timestamp: "2026-10-15T00:01:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "child only record" }] } })));
    }
    return { ok: false, status: 404 };
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
      root.render(React.createElement(SessionViewer));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const childSessionRow = [...rootElement.querySelectorAll(".session-item")].find((item) => item.textContent.includes("research/worker"));
    assert.match(childSessionRow.textContent, /子代理会话/);
    assert.match(childSessionRow.textContent, /父会话：Parent session/);
    assert.match(rootElement.querySelector(".subagent-section").textContent, /research\/worker/);
    const openChild = rootElement.querySelector('[aria-label="打开子代理轨迹：research/worker"]');
    assert.ok(openChild);
    await act(async () => {
      openChild.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rootElement.querySelectorAll('[role="tab"]').length, 2);
    assert.match(rootElement.querySelector('[role="tabpanel"]:not([hidden])').textContent, /child only record/);
    assert.match(rootElement.querySelector('[role="tabpanel"]:not([hidden]) .agent-context').textContent, /research\/worker/);
    const childRequestsBeforeSidebarOpen = childDetailRequests;
    await act(async () => {
      childSessionRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rootElement.querySelectorAll('[role="tab"]').length, 2);
    assert.equal(childDetailRequests, childRequestsBeforeSidebarOpen);
    assert.match(rootElement.querySelector('[role="tabpanel"]:not([hidden])').textContent, /child only record/);
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
