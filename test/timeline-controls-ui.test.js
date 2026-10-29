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
      isIntersecting: visible && !this.options.root.hidden,
      intersectionRatio: visible && !this.options.root.hidden ? 1 : 0,
    }]);
  }
}

test("JSONL 对象卡片独立收起、定位首末对象，并只在可见活动面板内显示控件", async () => {
  TestIntersectionObserver.instances = [];
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const rawByLine = new Map([
    [1, '{"secret":"Raw JSON must not copy"}'],
    [2, '{"fixture":2}'],
    [3, '{"secret":"non-text original data"}'],
  ]);
  const rawRequests = [];
  const fetchSyntheticView = async (input) => {
    const url = new URL(input, "http://localhost/");
    const params = url.searchParams;
    const line = Number(params.get("line"));
    const raw = rawByLine.get(line) ?? "{}";
    rawRequests.push({ view: params.get("view"), line, offset: Number(params.get("offset") ?? 0) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        offset: 0,
        nextOffset: new TextEncoder().encode(raw).byteLength,
        byteLength: new TextEncoder().encode(raw).byteLength,
        done: true,
        raw,
      }),
    };
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IntersectionObserver: TestIntersectionObserver,
    fetch: fetchSyntheticView,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  let clipboardText = "";
  let clipboardFails = false;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (clipboardFails) throw new Error("Synthetic clipboard failure");
        clipboardText = text;
      },
    },
  });
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let vite;
  let root;
  let restoreTimers;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { Timeline } = await vite.ssrLoadModule("/src/components/Timeline.jsx");
    const host = window.document.createElement("div");
    host.innerHTML = '<section class="session-tab-panel"></section>';
    window.document.body.append(host);
    const style = window.document.createElement("style");
    style.textContent = await readFile(new URL("../src/styles/timeline.css", import.meta.url), "utf8");
    window.document.head.append(style);
    assert.match(style.textContent, /\.event-body\.collapse-highlight::after[\s\S]*?radial-gradient[\s\S]*?filter:\s*blur\(23px\)/);
    assert.match(style.textContent, /\.event-body\.collapse-highlight::after[\s\S]*?pointer-events:\s*none/);
    const glowRules = style.textContent.match(/\.event-body\.collapse-highlight::after\s*\{([^}]+)\}/)?.[1] ?? "";
    assert.match(glowRules, /border-radius:\s*22px/);
    assert.doesNotMatch(glowRules, /border-radius:[^;]*%/);
    assert.match(glowRules, /radial-gradient\(ellipse 88% 31% at 6% 24%/);
    assert.match(glowRules, /radial-gradient\(ellipse 67% 24% at 96% 56%/);
    assert.match(glowRules, /radial-gradient\(ellipse 54% 37% at 41% 103%/);
    assert.match(glowRules, /radial-gradient\(ellipse 36% 19% at 74% -4%/);
    assert.doesNotMatch(glowRules, /box-shadow:|outline:/, "光晕不能表现为固定硬描边");
    assert.match(style.textContent, /-webkit-mask:\s*linear-gradient\(#fff 0 0\) padding-box, linear-gradient\(#fff 0 0\)/);
    assert.match(style.textContent, /mask-composite:\s*exclude/);
    assert.match(style.textContent, /animation:\s*event-collapse-rainbow\s+1\.2s\s+linear\s+infinite/);
    assert.match(style.textContent, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/);
    assert.match(style.textContent, /\.event-body\.collapse-highlight::after[\s\S]*?inset:\s*-14px/);
    assert.match(style.textContent, /@property\s+--event-rainbow-angle[\s\S]*?syntax:\s*"<angle>"/);
    assert.match(style.textContent, /conic-gradient\(from var\(--event-rainbow-angle, 0deg\)/);
    const rainbowKeyframes = style.textContent.match(/@keyframes\s+event-collapse-rainbow\s*\{([^}]+\}[^}]+\})/);
    assert.ok(rainbowKeyframes, "彩光动画关键帧存在");
    assert.match(rainbowKeyframes[1], /--event-rainbow-angle:\s*0deg/);
    assert.match(rainbowKeyframes[1], /--event-rainbow-angle:\s*360deg/);
    assert.match(rainbowKeyframes[1], /hue-rotate\(360deg\)/);
    assert.doesNotMatch(rainbowKeyframes[1], /transform\s*:/, "动画不旋转或缩放光晕本体");
    const panel = host.firstElementChild;
    root = createRoot(panel);

    const largeMarkdown = "Synthetic **rendered** first object\n\nSecond paragraph\n\n```js\nconst result = 1;\n```\n\n- list alpha\n- list beta\n\n".repeat(220);
    const entries = [
      { lineNumber: 1, timestamp: "2026-10-19T00:00:00Z", kind: "user", title: "Metadata title must not copy", markdown: true, text: largeMarkdown, originalLocator: { revision: "synthetic-revision" } },
      { lineNumber: 2, timestamp: "2026-10-19T00:00:01Z", kind: "assistant", title: "Assistant message", text: "Synthetic last object", originalLocator: { revision: "synthetic-revision" } },
      { lineNumber: 3, timestamp: "2026-10-19T00:00:02Z", kind: "tool-result", title: "Synthetic MCP result", contentParts: [{ kind: "plain", text: '{"type":"image","data":"opaque"}' }], originalLocator: { revision: "synthetic-revision" } },
    ];
    await act(async () => root.render(React.createElement(Timeline, { entries, sessionId: "synthetic-session" })));

    const cards = [...panel.querySelectorAll(".event-card")];
    const firstMeta = cards[0].querySelector(".event-meta");
    const firstContent = cards[0].querySelector(".event-content");
    assert.equal(cards.length, 3);
    assert.ok(firstContent.querySelector(".event-fragment-note"), "large Markdown is explicitly shown as bounded plain-text fragments");
    assert.match(firstContent.querySelector(".event-fragment-controls")?.textContent ?? "", /第 1 \/ 2 段/);
    assert.equal(panel.querySelectorAll(".event-controls").length, 3);
    assert.equal(cards[0].querySelector(".event-controls").getAttribute("aria-hidden"), "true");
    assert.equal(cards[0].querySelector("details pre"), null, "raw JSON text is not mounted before opening details");
    const rawDetails = cards[0].querySelector("details");
    await act(async () => {
      rawDetails.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(rawDetails.querySelector("pre")?.textContent ?? "", /Raw JSON must not copy/);
    await act(async () => rawDetails.querySelector("summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(cards[0].querySelector("details pre"), null, "closing details releases its raw JSON node");
    assert.deepEqual(rawRequests[0], { view: "raw", line: 1, offset: 0 }, "raw text is read from the bounded API by opaque session and physical line");
    const observer = TestIntersectionObserver.instances.at(-1);
    assert.ok(observer);
    assert.equal(observer.options.root, panel);
    const metaRectBeforeControls = firstMeta.getBoundingClientRect().toJSON();
    const contentRectBeforeControls = firstContent.getBoundingClientRect().toJSON();
    const controls = cards[0].querySelector(".event-controls");
    const controlsRectBeforeVisible = controls.getBoundingClientRect().toJSON();
    assert.equal(window.getComputedStyle(controls).visibility, "hidden");

    await act(async () => observer.report(cards[0], true));
    assert.equal(cards[0].querySelectorAll(".event-controls button").length, 4);
    assert.equal(cards[1].querySelectorAll(".event-controls").length, 1);
    assert.equal(cards[1].querySelector(".event-controls").getAttribute("aria-hidden"), "true");
    assert.equal(controls.previousElementSibling, firstMeta);
    assert.equal(controls.parentElement, cards[0].querySelector(".event-body"));
    assert.equal(window.getComputedStyle(controls).position, "sticky");
    assert.equal(window.getComputedStyle(controls).minHeight, "34px");
    assert.equal(window.getComputedStyle(controls).top, "8px");
    assert.equal(controls.getAttribute("aria-hidden"), "false");
    assert.equal(window.getComputedStyle(controls).visibility, "visible");
    assert.deepEqual(firstMeta.getBoundingClientRect().toJSON(), metaRectBeforeControls);
    assert.deepEqual(firstContent.getBoundingClientRect().toJSON(), contentRectBeforeControls);
    assert.deepEqual(controls.getBoundingClientRect().toJSON(), controlsRectBeforeVisible);
    panel.scrollTop = 420;
    assert.deepEqual(firstContent.getBoundingClientRect().toJSON(), contentRectBeforeControls);
    panel.scrollTop = 0;
    assert.deepEqual(firstContent.getBoundingClientRect().toJSON(), contentRectBeforeControls);
    await act(async () => observer.report(cards[0], false));
    assert.equal(cards[0].querySelector(".event-controls"), controls);
    assert.equal(controls.getAttribute("aria-hidden"), "true");
    assert.equal(window.getComputedStyle(controls).visibility, "hidden");
    assert.equal(controls.querySelector("button").tabIndex, -1);
    assert.deepEqual(firstMeta.getBoundingClientRect().toJSON(), metaRectBeforeControls);
    assert.deepEqual(firstContent.getBoundingClientRect().toJSON(), contentRectBeforeControls);
    assert.deepEqual(controls.getBoundingClientRect().toJSON(), controlsRectBeforeVisible);
    await act(async () => observer.report(cards[0], true));

    const buttonNames = [...cards[0].querySelectorAll(".event-controls button")]
      .map((button) => button.getAttribute("aria-label"));
    assert.deepEqual(buttonNames, [
      "复制对话",
      "收起第 1 行 JSONL 对象",
      "回到会话开始处",
      "跳转到会话末尾",
    ]);
    assert.equal(cards[0].querySelector(".event-controls button")?.textContent, "复制对话");
    const copyButton = cards[0].querySelector('[aria-label="复制对话"]');
    await act(async () => {
      copyButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.match(clipboardText, /Synthetic\s+rendered\s+first object/);
    assert.match(clipboardText, /const result = 1;/);
    assert.match(clipboardText, /list alpha[\s\S]*list beta/);
    assert.doesNotMatch(clipboardText, /```|\*\*/);
    assert.ok((clipboardText.match(/Synthetic rendered first object/g) ?? []).length > 100, "explicit copying renders every Markdown page");
    assert.doesNotMatch(clipboardText, /Metadata title must not copy|Raw JSON must not copy|原始 JSON|复制对话/);
    assert.equal(cards[0].querySelector('[role="status"]')?.textContent, "已复制");

    clipboardFails = true;
    await act(async () => {
      copyButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(cards[0].querySelector('[role="status"]')?.textContent, "复制失败");

    const centerScrollCalls = [];
    panel.scrollTop = 200;
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1600 });
    panel.getBoundingClientRect = () => ({ top: 100, height: 300 });
    firstMeta.getBoundingClientRect = () => ({ top: 500, bottom: 520 });
    cards[0].getBoundingClientRect = () => ({
      top: 100 + 800 - panel.scrollTop,
      height: cards[0].querySelector(".event-body").classList.contains("collapsed") ? 60 : 120,
    });
    panel.scrollTo = (options) => {
      centerScrollCalls.push(options);
      panel.scrollTop = options.top;
    };

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let timerNow = 0;
    let nextTimerId = 1;
    const timers = new Map();
    globalThis.setTimeout = (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, at: timerNow + delay });
      return id;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);
    restoreTimers = () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      restoreTimers = null;
    };
    const advanceTimers = async (amount) => {
      timerNow += amount;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= timerNow);
      for (const [id, timer] of due) {
        timers.delete(id);
        await act(async () => timer.callback());
      }
    };

    const collapseButton = cards[0].querySelector('[aria-label="收起第 1 行 JSONL 对象"]');
    assert.equal(collapseButton?.textContent, "收起对话");
    await act(async () => collapseButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(centerScrollCalls, [{ top: 680, behavior: "smooth" }]);
    assert.ok(cards[0].querySelector(".event-body").classList.contains("collapse-highlight"));
    assert.equal(cards[0].classList.contains("collapse-highlight"), false);
    assert.equal(window.getComputedStyle(controls).position, "sticky");
    assert.equal(window.getComputedStyle(controls).zIndex, "2");
    assert.equal(window.getComputedStyle(controls).visibility, "visible");
    assert.equal(timers.size, 1);
    assert.equal(cards[0].querySelector(".event-text"), null);
    assert.equal(cards[0].querySelector(".event-content"), null, "collapsing releases the rendered body subtree");
    assert.equal(cards[0].querySelector(".event-meta")?.textContent.includes("Metadata title must not copy"), true);
    assert.equal(cards[0].querySelector('[aria-label="展开第 1 行 JSONL 对象"]')?.textContent, "展开");
    assert.match(cards[1].textContent, /Synthetic last object/);

    clipboardFails = false;
    await act(async () => {
      copyButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.match(clipboardText, /Synthetic rendered first object\n{1,2}Second paragraph/);
    assert.doesNotMatch(clipboardText, /Metadata title must not copy|Raw JSON must not copy|原始 JSON|复制对话/);

    const topBeforeExpand = cards[0].getBoundingClientRect().top;
    const scrollTopBeforeExpand = panel.scrollTop;
    await act(async () => cards[0].querySelector('[aria-label="展开第 1 行 JSONL 对象"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(centerScrollCalls, [
      { top: 680, behavior: "smooth" },
    ]);
    assert.equal(panel.scrollTop, scrollTopBeforeExpand);
    assert.equal(cards[0].getBoundingClientRect().top, topBeforeExpand);
    assert.ok(cards[0].querySelector(".event-body").classList.contains("collapse-highlight"), "展开不会触发或清除收起提示");
    assert.equal(timers.size, 1, "展开不会创建新的提示计时器");

    firstMeta.getBoundingClientRect = () => ({ top: 120, bottom: 160 });
    const topBeforeVisibleCollapse = cards[0].getBoundingClientRect().top;
    await act(async () => cards[0].querySelector('[aria-label="收起第 1 行 JSONL 对象"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(centerScrollCalls, [{ top: 680, behavior: "smooth" }]);
    assert.equal(cards[0].getBoundingClientRect().top, topBeforeVisibleCollapse);
    assert.equal(timers.size, 1, "重复收起会替换同一卡片的计时器");
    await advanceTimers(2999);
    assert.ok(cards[0].querySelector(".event-body").classList.contains("collapse-highlight"));
    await advanceTimers(1);
    assert.equal(cards[0].querySelector(".event-body").classList.contains("collapse-highlight"), false);
    assert.equal(window.getComputedStyle(controls).position, "sticky");
    assert.equal(window.getComputedStyle(controls).zIndex, "2");
    assert.equal(window.getComputedStyle(controls).visibility, "visible");
    assert.equal(timers.size, 0);

    await act(async () => observer.report(cards[2], true));
    cards[2].querySelector(".event-meta").getBoundingClientRect = () => ({ top: 120, bottom: 160 });
    await act(async () => cards[2].querySelector('[aria-label="收起第 3 行 JSONL 对象"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(cards[2].querySelector(".event-content"), null);
    await act(async () => {
      cards[2].querySelector('[aria-label="复制对话"]')
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.match(clipboardText, /"type":"image"/);
    assert.doesNotMatch(clipboardText, /non-text original data|原始 JSON/);
    await advanceTimers(3000);
    assert.equal(timers.size, 0);

    await act(async () => cards[0].querySelector('[aria-label="展开第 1 行 JSONL 对象"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(centerScrollCalls, [{ top: 680, behavior: "smooth" }]);

    const scrollCalls = [];
    panel.scrollTop = 30;
    panel.scrollTo = (options) => scrollCalls.push(options);
    panel.getBoundingClientRect = () => ({ top: 100 });
    cards[0].getBoundingClientRect = () => ({ top: 150 });
    cards[1].getBoundingClientRect = () => ({ top: 480 });
    cards[2].getBoundingClientRect = () => ({ top: 480 });
    await act(async () => cards[0].querySelector('[aria-label="跳转到会话末尾"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    await act(async () => cards[0].querySelector('[aria-label="回到会话开始处"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(scrollCalls, [], "virtualized edge navigation addresses data indices directly");
    assert.ok(Number.isFinite(panel.scrollTop));

    panel.hidden = true;
    await act(async () => observer.report(cards[0], true));
    assert.equal(cards[0].querySelector(".event-controls"), controls);
    assert.equal(controls.getAttribute("aria-hidden"), "true");
    panel.hidden = false;
    await act(async () => observer.report(cards[1], true));
    assert.equal(cards[1].querySelectorAll(".event-controls button").length, 4);
    await act(async () => observer.report(cards[0], false));
    assert.equal(cards[0].querySelector(".event-controls"), controls);
    assert.equal(controls.getAttribute("aria-hidden"), "true");

    await act(async () => cards[0].querySelector('[aria-label="收起第 1 行 JSONL 对象"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(timers.size, 1, "an active collapse highlight owns one pending timer");
    await act(async () => root.unmount());
    root = null;
    assert.equal(timers.size, 0, "unmount clears pending highlight timers");
    assert.equal(observer.disconnectCount, 1, "unmount disconnects the timeline observer");
  } finally {
    restoreTimers?.();
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
