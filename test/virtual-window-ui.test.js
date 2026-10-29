import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createServer } from "vite";

class TestResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnectCount = 0;
    TestResizeObserver.instances.push(this);
  }

  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.disconnectCount += 1; this.targets.clear(); }

  emit(target, height) {
    this.callback([{ target, borderBoxSize: [{ blockSize: height }], contentRect: { height } }]);
  }
}

class TestIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnectCount = 0;
    TestIntersectionObserver.instances.push(this);
  }

  observe(target) { this.targets.add(target); }
  disconnect() { this.disconnectCount += 1; this.targets.clear(); }
  report(target, visible = true) {
    this.callback([{
      target,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
    }]);
  }
}

function setGlobal(original, key, value) {
  original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function restoreGlobals(original) {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

function makeEntries(count) {
  const longMarkdown = "Synthetic **rendered** first object\n\nSecond paragraph\n\n```js\nconst value = 1;\n```\n\n- alpha\n- beta\n\n".repeat(220);
  return Array.from({ length: count }, (_, index) => ({
    lineNumber: index + 1,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    kind: "user",
    title: `Synthetic record ${index + 1}`,
    markdown: index === 0,
    text: index === 0 ? longMarkdown : `Synthetic body ${index + 1}`,
    raw: index === count - 1 ? '{"marker":"needle-from-raw"}' : `{"line":${index + 1}}`,
  }));
}

function makeSessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}${index === count - 1 ? " needle" : ""}`,
    preview: `Preview ${index}`,
    cwd: "/synthetic/project",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
}

test("timeline and sidebar virtual windows bound rows, retain reading state, search data, and preserve focus", async () => {
  TestResizeObserver.instances = [];
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
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    ResizeObserver: TestResizeObserver,
    IntersectionObserver: TestIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) setGlobal(original, key, value);
  const { createRoot } = await import("react-dom/client");

  const host = window.document.createElement("div");
  host.innerHTML = `
    <section class="session-tab-panel" id="panel-large"></section>
    <section class="session-tab-panel" id="panel-small"></section>
    <div id="sidebar-host"></div>`;
  window.document.body.append(host);
  const panelLarge = host.querySelector("#panel-large");
  const panelSmall = host.querySelector("#panel-small");
  for (const panel of [panelLarge, panelSmall]) {
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 10_000_000 });
    panel.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 960, width: 960 });
    panel.scrollTo = (options) => { panel.scrollTop = options.top; };
  }

  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  const originalFocus = window.HTMLElement.prototype.focus;
  const implicitFocusScrolls = [];
  window.HTMLElement.prototype.focus = function focus(options) {
    originalFocus.call(this, options);
    // happy-dom does not implement the browser's focus-induced scrolling.
    // Model it so overscan focus restoration cannot silently move the viewport.
    const panel = this.closest?.('.session-tab-panel');
    if (!panel || !this.classList?.contains('event-card') || options?.preventScroll) return;
    const rect = this.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > panel.clientHeight) {
      implicitFocusScrolls.push(Number(this.dataset.entryIndex));
      panel.scrollTop += rect.top < 0 ? rect.top : rect.bottom - panel.clientHeight;
    }
  };
  const measuredHeights = new Map();
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains("timeline")) {
      const panel = this.closest(".session-tab-panel");
      const top = 80 - panel.scrollTop;
      return { top, bottom: top + 9_000_000, height: 9_000_000, left: 0, right: 960, width: 960 };
    }
    if (this.classList?.contains("event-card")) {
      const panel = this.closest(".session-tab-panel");
      const index = Number(this.dataset.entryIndex);
      const height = measuredHeights.get(index) ?? 176;
      const top = 80 + index * 176 - panel.scrollTop;
      return { top, bottom: top + height, height, left: 0, right: 960, width: 960 };
    }
    if (this.classList?.contains("event-meta")) {
      const panel = this.closest(".session-tab-panel");
      const index = Number(this.closest(".event-card")?.dataset.entryIndex ?? 0);
      const top = 88 + index * 176 - panel.scrollTop;
      return { top, bottom: top + 24, height: 24, left: 0, right: 960, width: 960 };
    }
    if (this.classList?.contains("session-tab-panel")) return { top: 0, bottom: 600, height: 600, left: 0, right: 960, width: 960 };
    if (this.classList?.contains("session-list")) return { top: 0, bottom: 480, height: 480, left: 0, right: 300, width: 300 };
    if (this.classList?.contains("project-group-row")) {
      const height = this.classList.contains("project-group-heading-row") ? 42 : 86;
      return { top: 0, bottom: height, height, left: 0, right: 300, width: 300 };
    }
    return originalRect.call(this);
  };

  let vite;
  let largeRoot;
  let smallRoot;
  let sidebarRoot;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const [{ Timeline }, { SessionSidebar }] = await Promise.all([
      vite.ssrLoadModule("/src/components/Timeline.jsx"),
      vite.ssrLoadModule("/src/components/SessionSidebar.jsx"),
    ]);
    largeRoot = createRoot(panelLarge);
    smallRoot = createRoot(panelSmall);
    sidebarRoot = createRoot(host.querySelector("#sidebar-host"));

    const entries = makeEntries(50_000);
    const sidebarSessions = makeSessions(1_000);
    const searchByApi = async (query, afterLine) => {
      assert.equal(afterLine, 1);
      return query === "needle-from-raw" ? 50_000 : null;
    };
    const renderSidebar = (sessions) => React.createElement(SessionSidebar, {
      sessions,
      activeSessionId: null,
      onOpenSession: () => {},
      onRefresh: () => {},
      loading: false,
    });

    await act(async () => {
      largeRoot.render(React.createElement(Timeline, { entries, active: true, onSearch: searchByApi }));
      smallRoot.render(React.createElement(Timeline, { entries: makeEntries(2), active: true }));
      sidebarRoot.render(renderSidebar(sidebarSessions));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const timeline = panelLarge.querySelector(".timeline");
    const cardsInitially = [...timeline.querySelectorAll(".event-card")];
    assert.ok(cardsInitially.length > 0 && cardsInitially.length <= 100);
    assert.equal(timeline.getAttribute("aria-setsize"), "50000");
    assert.ok(Number.isFinite(Number.parseFloat(timeline.querySelector(".timeline-virtual-spacer").style.height)));

    const allInputs = [...host.querySelectorAll(".timeline-toolbar input")];
    const inputIds = allInputs.map((input) => input.id);
    assert.equal(new Set(inputIds).size, inputIds.length, "each open timeline owns unique label/input IDs");
    for (const input of allInputs) {
      assert.equal(host.querySelector(`label[for="${input.id}"]`)?.getAttribute("for"), input.id);
    }

    const first = timeline.querySelector('[data-entry-index="0"]');
    const initialObserver = TestIntersectionObserver.instances.find((observer) => observer.options.root === panelLarge && observer.targets.has(first));
    assert.ok(initialObserver);
    await act(async () => initialObserver.report(first));
    assert.match(first.querySelector(".event-fragment-controls")?.textContent ?? "", /第 1 \/ 2 段/);
    await act(async () => {
      first.querySelector(".event-fragment-controls button:last-child").click();
    });
    assert.match(first.querySelector(".event-fragment-controls")?.textContent ?? "", /第 2 \/ 2 段/);
    await act(async () => first.querySelector("details summary").click());
    assert.equal(first.querySelector("details").open, true);

    const second = timeline.querySelector('[data-entry-index="1"]');
    const secondObserver = TestIntersectionObserver.instances.find((observer) => observer.options.root === panelLarge && observer.targets.has(second));
    assert.ok(secondObserver);
    await act(async () => secondObserver.report(second));
    await act(async () => second.querySelector('[aria-label="收起第 2 行 JSONL 对象"]').click());
    assert.ok(second.querySelector(".event-body").classList.contains("collapsed"));

    const oldFirstCard = first;
    first.focus();
    panelLarge.scrollTop = 100_000;
    await act(async () => {
      panelLarge.dispatchEvent(new window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(timeline.querySelector('[data-entry-index="0"]'), null, "scrolling unmounts offscreen timeline cards");
    assert.ok([...timeline.querySelectorAll(".event-card")].every((card) => Number(card.dataset.entryIndex) > 100));
    assert.ok(timeline.querySelectorAll(".event-card").length <= 100);
    assert.ok(timeline.contains(window.document.activeElement), "focus moves to a mounted card when the focused row scrolls out of the window");
    assert.ok(Number(window.document.activeElement.dataset.entryIndex) > 100);
    assert.equal(panelLarge.scrollTop, 100_000, 'restoring focus after virtual unmount must not pull the viewport upward');
    assert.deepEqual(implicitFocusScrolls, []);
    assert.ok(initialObserver.disconnectCount > 0, "observer subscriptions are released when the window changes");
    initialObserver.report(oldFirstCard, true); // A late callback from a disconnected window must be ignored.

    for (const nextTop of [120_000, 150_000]) {
      panelLarge.scrollTop = nextTop;
      await act(async () => {
        panelLarge.dispatchEvent(new window.Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      assert.equal(panelLarge.scrollTop, nextTop, 'successive virtual windows preserve the user scroll position');
      assert.ok(timeline.contains(window.document.activeElement), 'keyboard focus still follows the mounted window');
      assert.deepEqual(implicitFocusScrolls, []);
    }

    const anchorIndex = Math.floor((panelLarge.scrollTop - 80) / 176);
    const firstVisibleCard = [...timeline.querySelectorAll(".event-card")]
      .find((card) => Number(card.dataset.entryIndex) < anchorIndex);
    assert.ok(firstVisibleCard, "overscan renders a measured row before the viewport anchor");
    const firstVisibleIndex = Number(firstVisibleCard.dataset.entryIndex);
    const timelineResizeObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(firstVisibleCard));
    assert.ok(timelineResizeObserver);
    const scrollBeforeMeasurement = panelLarge.scrollTop;
    measuredHeights.set(firstVisibleIndex, 400);
    await act(async () => timelineResizeObserver.emit(firstVisibleCard, 400));
    assert.equal(panelLarge.scrollTop, scrollBeforeMeasurement + 224, "height correction above the anchor shifts scroll by the exact measured delta");

    const findInput = timeline.closest(".session-tab-panel").querySelector('input[type="search"]');
    findInput.value = "needle-from-raw";
    await act(async () => timeline.closest(".session-tab-panel").querySelector(".timeline-find").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    const lastEntry = timeline.querySelector('[data-entry-index="49999"]');
    assert.ok(lastEntry, `data search finds raw JSON text in an unmounted entry (query=${findInput.value}, status=${timeline.closest(".session-tab-panel").querySelector(".timeline-navigation-status").textContent})`);
    assert.match(timeline.closest(".session-tab-panel").querySelector(".timeline-navigation-status").textContent, /50000 \/ 50000/);

    await act(async () => panelLarge.querySelector('.timeline-toolbar [aria-label="回到会话开始处"]').click());
    const restoredFirst = timeline.querySelector('[data-entry-index="0"]');
    const restoredSecond = timeline.querySelector('[data-entry-index="1"]');
    assert.ok(restoredFirst && restoredSecond);
    assert.match(restoredFirst.querySelector(".event-fragment-controls")?.textContent ?? "", /第 2 \/ 2 段/, "offscreen fragment position remains keyed by entry ID");
    assert.equal(restoredFirst.querySelector("details").open, true, "offscreen raw expansion remains keyed by entry ID");
    assert.ok(restoredSecond.querySelector(".event-body").classList.contains("collapsed"), "offscreen collapse state remains keyed by entry ID");
    assert.equal(restoredFirst.querySelector(".event-controls").getAttribute("aria-hidden"), "true", "late visibility callbacks from the previous window do not expose controls");

    const ordinal = timeline.closest(".session-tab-panel").querySelector('input[type="number"]');
    ordinal.value = "1";
    await act(async () => ordinal.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.ok(timeline.querySelector('[data-entry-index="0"]'));

    const savedScrollTop = panelLarge.scrollTop;
    const activeObservers = TestResizeObserver.instances.filter((observer) => observer.targets.has(timeline));
    await act(async () => largeRoot.render(React.createElement(Timeline, { entries, active: false })));
    assert.ok(activeObservers.some((observer) => observer.disconnectCount > 0), "background timeline stops resize measurement");
    panelLarge.scrollTop = 300_000;
    await act(async () => panelLarge.dispatchEvent(new window.Event("scroll")));
    assert.ok(timeline.querySelector('[data-entry-index="0"]'), "background timeline retains its last virtual window");
    await act(async () => largeRoot.render(React.createElement(Timeline, { entries, active: true })));
    assert.ok(panelLarge.scrollTop >= savedScrollTop, "activation recalibrates from the retained panel scroll position");
    assert.ok(!timeline.querySelector('[data-entry-index="0"]'), "activation restores the current viewport window");

    const sidebar = host.querySelector(".sidebar");
    const sessionList = sidebar.querySelector(".session-list");
    Object.defineProperty(sessionList, "clientHeight", { configurable: true, value: 480 });
    const sidebarResizeObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(sessionList));
    assert.ok(sidebarResizeObserver);
    await act(async () => sidebarResizeObserver.emit(sessionList, 480));
    const mountedSessions = [...sessionList.querySelectorAll(".session-item")];
    assert.ok(mountedSessions.length > 0 && mountedSessions.length <= 100);
    assert.equal(sessionList.getAttribute("aria-setsize"), "1001", "project headings and sessions share a flattened window");
    assert.equal(sessionList.querySelector(".project-heading small")?.textContent, "/synthetic/project");

    await act(async () => {
      mountedSessions[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    const lastSession = sessionList.querySelector('[data-sidebar-key="session:session-0"]');
    assert.ok(lastSession, "End reaches a session outside the initial window");
    assert.equal(window.document.activeElement, lastSession, "offscreen keyboard navigation restores focus after mounting");
    await act(async () => lastSession.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(window.document.activeElement?.dataset.sidebarKey, "session:session-999");

    sessionList.scrollTop = 50_000;
    await act(async () => {
      sessionList.dispatchEvent(new window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.ok(sessionList.contains(window.document.activeElement), "sidebar focus transfers to a mounted row after scrolling its focused item out");
    assert.ok(window.document.activeElement.matches(".session-item"));

    sessionList.scrollTop = 50_000;
    const searchInput = sidebar.querySelector(".search-box input");
    const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setInputValue.call(searchInput, "needle");
    await act(async () => searchInput.dispatchEvent(new window.Event("input", { bubbles: true })));
    assert.equal(sessionList.scrollTop, 0, "sidebar search results reset to the top");
    assert.equal(sessionList.querySelectorAll(".session-item").length, 1);
    assert.match(sessionList.textContent, /Session 999/);

    await act(async () => {
      largeRoot.unmount();
      smallRoot.unmount();
      sidebarRoot.unmount();
    });
    assert.ok(TestResizeObserver.instances.every((observer) => observer.disconnectCount > 0), "closing all views releases every resize observer");
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    await vite?.close();
    window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    restoreGlobals(original);
    window.happyDOM.abort();
  }
});

test("测量补偿等待新虚拟高度提交，底部增长不被旧 scrollHeight 截断", async () => {
  const window = new Window({ url: 'http://localhost/' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, ResizeObserver: TestResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) setGlobal(original, key, value);
  const { createRoot } = await import('react-dom/client');
  const panel = window.document.createElement('section');
  window.document.body.append(panel);
  Object.defineProperty(panel, 'clientHeight', { value: 100 });
  let scrollTop = 0;
  Object.defineProperty(panel, 'scrollTop', {
    get: () => Math.max(0, Math.min(scrollTop, Number.parseFloat(panel.firstChild?.style.height || '0') - 100)),
    set: (value) => { scrollTop = Math.max(0, Math.min(value, Number.parseFloat(panel.firstChild?.style.height || '0') - 100)); },
  });
  let vite;
  const root = createRoot(panel);
  const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
  const getScrollElement = () => panel;
  try {
    vite = await createServer({ configFile: new URL('../vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
    const { useVirtualWindow } = await vite.ssrLoadModule('/src/hooks/useVirtualWindow.js');
    let virtual;
    function Harness({ active = true }) {
      virtual = useVirtualWindow({ itemKeys: keys, getScrollElement, enabled: active, estimatedHeight: 100, maxItems: 20 });
      return React.createElement('div', { ref: virtual.listRef, style: { height: virtual.range.totalHeight } },
        keys.map((key, i) => React.createElement('div', { key, ref: (node) => virtual.registerItem(key, node), 'data-virtual-key': key, 'data-virtual-index': i })));
    }
    await act(async () => root.render(React.createElement(Harness)));
    panel.scrollTop = 1900;
    await act(async () => virtual.refreshWindow());
    const node = panel.querySelector('[data-virtual-index="18"]');
    const observer = TestResizeObserver.instances.findLast((candidate) => candidate.targets.has(node));
    await act(async () => observer.emit(node, 200));
    assert.equal(panel.firstChild.style.height, '2100px');
    assert.equal(panel.scrollTop, 2000, 'full correction applies after total height grows');
    await act(async () => observer.emit(node, 100));
    assert.equal(panel.scrollTop, 1900, 'shrink preserves the same anchor');
    panel.scrollTop = 0;
    await act(async () => virtual.refreshWindow());
    await act(async () => observer.emit(node, 200));
    assert.equal(panel.scrollTop, 0, 'content below the viewport does not move the top');
    await act(async () => root.render(React.createElement(Harness, { active: false })));
    await act(async () => observer.emit(node, 300));
    assert.equal(panel.scrollTop, 0, 'late observer callbacks cannot move a background panel');
  } finally {
    await act(async () => root.unmount());
    await vite?.close();
    window.happyDOM.abort();
    restoreGlobals(original);
  }
});
