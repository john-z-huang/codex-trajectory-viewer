import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function makeEntry(lineNumber, revision, text, overrides = {}) {
  return {
    lineNumber,
    timestamp: "2026-10-29T00:00:00Z",
    kind: "assistant",
    title: `Synthetic line ${lineNumber}`,
    text,
    markdown: true,
    originalLocator: { revision },
    ...overrides,
  };
}

test("时间线按物理行恢复分页阅读状态，修订时只清原文偏移并支持大行复制与原生下载", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const rawRequests = [];
  const nativeDownloads = [];
  const staleEvents = [];
  const onRevisionStale = (...args) => { staleEvents.push(args); };
  let nextRawResponse = null;
  window.HTMLAnchorElement.prototype.click = function () {
    nativeDownloads.push({ href: this.getAttribute("href"), download: this.download });
  };
  const fullMarkdown = `Synthetic long Markdown **bold**\n\n${"Long line content with emoji 😀 and 中文.\n\n".repeat(2200)}`;
  const downloadedLine = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: fullMarkdown }],
    },
  });
  const fetchSyntheticView = async (input, options = {}) => {
    const url = new URL(input, "http://localhost/");
    const params = url.searchParams;
    const view = params.get("view");
    const line = Number(params.get("line"));
    const offset = Number(params.get("offset") ?? 0);
    rawRequests.push({ view, line, offset, revision: params.get("revision"), operationId: options.headers?.["X-Operation-Id"] });
    if (view === "raw") {
      if (nextRawResponse) {
        const response = nextRawResponse;
        nextRawResponse = null;
        return await response;
      }
      const byteLength = 50_000;
      const nextOffset = Math.min(offset + 16 * 1024, byteLength);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          revision: params.get("revision"),
          lineNumber: line,
          offset,
          nextOffset,
          byteLength,
          done: nextOffset >= byteLength,
          raw: "r".repeat(nextOffset - offset),
        }),
      };
    }
    if (view === "download") {
      return { ok: true, status: 200, text: async () => downloadedLine };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Unexpected synthetic request" }) };
  };
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
    fetch: fetchSyntheticView,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { window.__clipboardText = text; } },
  });
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let vite;
  let primaryRoot;
  let secondRoot;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { Timeline } = await vite.ssrLoadModule("/src/components/Timeline.jsx");
    const host = window.document.createElement("div");
    host.innerHTML = '<section class="session-tab-panel" id="primary"></section><section class="session-tab-panel" id="secondary"></section>';
    window.document.body.append(host);
    const primaryPanel = host.querySelector("#primary");
    const secondaryPanel = host.querySelector("#secondary");
    for (const panel of [primaryPanel, secondaryPanel]) {
      Object.defineProperty(panel, "clientHeight", { configurable: true, value: 600 });
      Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 600 });
      panel.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 960, width: 960 });
      panel.scrollTo = ({ top }) => { panel.scrollTop = top; };
    }
    primaryRoot = createRoot(primaryPanel);
    secondRoot = createRoot(secondaryPanel);

    const line33Text = `Fragment one.\n\n${"Fragment body **bold** with 中文 and emoji 😀.\n\n".repeat(900)}`;
    const line33 = makeEntry(33, "revision-1", line33Text);
    const renderPage = (root, entries, revision, startLine) => root.render(React.createElement(Timeline, {
      entries,
      sessionId: "synthetic-session",
      rollout: { revision, totalLines: 65, pageSize: 32, startLine },
      onRevisionStale,
    }));

    await act(async () => {
      renderPage(primaryRoot, [line33], "revision-1", 33);
      renderPage(secondRoot, [line33], "revision-1", 33);
    });
    const firstCard = primaryPanel.querySelector(".event-card");
    const secondCard = secondaryPanel.querySelector(".event-card");
    const openRaw = async (card) => {
      await act(async () => {
        card.querySelector("details summary").click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await openRaw(firstCard);
    await openRaw(secondCard);

    const rawInputs = [...window.document.querySelectorAll(".event-raw-offset input")];
    const rawInputIds = rawInputs.map((input) => input.id);
    assert.equal(rawInputs.length, 2);
    assert.equal(new Set(rawInputIds).size, 2, "raw offset inputs remain unique when the same physical row is open in separate tabs");
    for (const input of rawInputs) assert.equal(host.querySelector(`label[for="${input.id}"]`)?.htmlFor, input.id);

    await act(async () => {
      [...firstCard.querySelectorAll(".event-raw-toolbar button")].find((button) => button.textContent === "下一片").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(rawRequests.filter((request) => request.view === "raw" && request.line === 33).map(({ offset }) => offset), [0, 0, 16_384]);
    assert.match(firstCard.querySelector(".event-fragment-controls")?.textContent ?? "", /第 1 \/ \d+ 段/);
    await act(async () => firstCard.querySelector(".event-fragment-controls button:last-child").click());
    assert.match(firstCard.querySelector(".event-fragment-controls")?.textContent ?? "", /第 2 \/ \d+ 段/);

    await act(async () => firstCard.querySelector('[aria-label="收起第 33 行 JSONL 对象"]').click());
    assert.ok(firstCard.querySelector(".event-body").classList.contains("collapsed"));
    const line65Oversized = makeEntry(65, "revision-1", undefined, {
      kind: "oversized",
      title: "超大记录…",
      titleTruncated: true,
      projectionLimited: true,
    });
    await act(async () => renderPage(primaryRoot, [line65Oversized], "revision-1", 65));
    const oversizedCard = primaryPanel.querySelector(".event-card");
    assert.match(oversizedCard.querySelector(".event-title")?.getAttribute("title") ?? "", /预览已省略/);
    await openRaw(oversizedCard);
    const rawDownload = oversizedCard.querySelector('.event-raw-toolbar a[download]');
    assert.equal(rawDownload?.download, "rollout-line-65.txt");
    assert.match(rawDownload?.getAttribute("href") ?? "", /view=download.*line=65/);
    assert.match(oversizedCard.querySelector(".event-raw-download-note")?.textContent ?? "", /版本变化时，请刷新后重试/);
    const nativeDownloadClick = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      rawDownload.dispatchEvent(nativeDownloadClick);
      rawDownload.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.equal(nativeDownloadClick.defaultPrevented, true, "validate the version before handing the URL to the browser");
    assert.equal(nativeDownloads.length, 1);
    assert.equal(nativeDownloads[0].download, "rollout-line-65.txt");
    const dispatchedUrl = new URL(nativeDownloads[0].href, "http://localhost/");
    const downloadOperation = dispatchedUrl.searchParams.get("operation_id");
    assert.match(downloadOperation, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    dispatchedUrl.searchParams.delete("operation_id");
    assert.equal(dispatchedUrl.href, new URL(rawDownload.getAttribute("href"), "http://localhost/").href);
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 65).at(-1).operationId, downloadOperation, "native download and bounded precheck share a non-content operation ID");
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 65).length, 2, "duplicate clicks share one bounded check after the initial raw read");
    assert.equal(rawRequests.some((request) => request.view === "download"), false);

    await act(async () => {
      oversizedCard.querySelector('[aria-label="复制对话"]').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const copied = window.__clipboardText ?? "";
    assert.ok(copied.length > 70_000, `the full non-first physical line is copied (received ${copied.length} characters)`);
    assert.match(copied, /Synthetic long Markdown bold/);
    assert.match(copied, /emoji 😀 and 中文/);
    assert.doesNotMatch(copied, /\*\*/);
    assert.equal(oversizedCard.querySelector(".event-copy-status")?.textContent, "已复制");
    assert.equal(rawRequests.filter((request) => request.view === "download").length, 1, "full line download occurs only for explicit copy");

    await act(async () => renderPage(primaryRoot, [line33], "revision-1", 33));
    let restoredCard = primaryPanel.querySelector(".event-card");
    assert.ok(restoredCard.querySelector(".event-body").classList.contains("collapsed"), "collapse state is keyed by stable physical line across pages");
    await act(async () => restoredCard.querySelector('[aria-label="展开第 33 行 JSONL 对象"]').click());
    assert.match(restoredCard.querySelector(".event-fragment-controls")?.textContent ?? "", /第 2 \/ \d+ 段/, "body fragment page is retained while the row is off-page");
    await openRaw(restoredCard);
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 33).at(-1)?.offset, 16_384, "raw byte offset is restored when the physical line returns to the page");
    assert.equal([...restoredCard.querySelectorAll(".event-raw-toolbar button")].find((button) => button.textContent === "上一片")?.disabled, false);

    await act(async () => {
      [...restoredCard.querySelectorAll(".event-raw-toolbar button")].find((button) => button.textContent === "上一片").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 33).at(-1)?.offset, 0, "the offset history navigates back to the earlier chunk");
    await act(async () => {
      [...restoredCard.querySelectorAll(".event-raw-toolbar button")].find((button) => button.textContent === "下一片").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 33).at(-1)?.offset, 16_384);
    await act(async () => restoredCard.querySelector('[aria-label="收起第 33 行 JSONL 对象"]').click());

    const line33Revision2 = makeEntry(33, "revision-2", line33Text);
    await act(async () => {
      renderPage(primaryRoot, [line33Revision2], "revision-2", 33);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    restoredCard = primaryPanel.querySelector(".event-card");
    assert.ok(restoredCard.querySelector(".event-body").classList.contains("collapsed"), "collapse state survives a file revision change");
    await act(async () => restoredCard.querySelector('[aria-label="展开第 33 行 JSONL 对象"]').click());
    assert.match(restoredCard.querySelector(".event-fragment-controls")?.textContent ?? "", /第 2 \/ \d+ 段/, "body fragment page survives a file revision change");
    await openRaw(restoredCard);
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 33).at(-1)?.offset, 0, "a raw offset from the previous revision is never sent to the new content");
    assert.equal(rawRequests.filter((request) => request.view === "raw" && request.line === 33 && request.revision === "revision-2").at(-1)?.offset, 0);
    assert.equal([...restoredCard.querySelectorAll(".event-raw-toolbar button")].find((button) => button.textContent === "上一片")?.disabled, true, "revision change clears raw offset history");

    const clickDownload = async () => act(async () => {
      restoredCard.querySelector('a[download]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    nextRawResponse = { ok: false, status: 409, json: async () => ({ error: "Synthetic expired version", code: "revision_mismatch" }) };
    await clickDownload();
    assert.match(restoredCard.querySelector('[role="alert"]')?.textContent ?? "", /版本已变化.*刷新/);
    assert.equal(nativeDownloads.length, 1, "stale versions never start a failing browser download");
    assert.deepEqual(staleEvents, [[33, "revision-2"]]);

    nextRawResponse = { ok: false, status: 404, json: async () => ({ error: "Synthetic session not found" }) };
    await clickDownload();
    assert.match(restoredCard.querySelector('[role="alert"]')?.textContent ?? "", /Synthetic session not found/);
    assert.equal(nativeDownloads.length, 1, "server errors are displayed in the page");

    nextRawResponse = Promise.reject(new TypeError("Synthetic network failure"));
    await clickDownload();
    assert.match(restoredCard.querySelector('[role="alert"]')?.textContent ?? "", /Synthetic network failure/);
    assert.equal(nativeDownloads.length, 1);
    await clickDownload();
    assert.equal(nativeDownloads.length, 2, "retry after a transient failure hands the original URL to the browser");
    assert.equal(restoredCard.querySelector('[role="alert"]'), null);

    let finishCheck;
    nextRawResponse = new Promise((resolve) => { finishCheck = resolve; });
    await clickDownload();
    assert.equal(restoredCard.querySelector('a[download]').getAttribute("aria-disabled"), "true");
    await act(async () => renderPage(primaryRoot, [makeEntry(33, "revision-3", line33Text)], "revision-3", 33));
    await act(async () => finishCheck({ ok: true, status: 200, json: async () => ({ raw: "synthetic" }) }));
    assert.equal(nativeDownloads.length, 2, "switching versions cancels a pending check without downloading the old version");
  } finally {
    if (primaryRoot) await act(async () => primaryRoot.unmount());
    if (secondRoot) await act(async () => secondRoot.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
