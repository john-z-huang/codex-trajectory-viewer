import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { initialWorkspace, workspaceReducer } from "../src/tabs.js";
import { downloadUrl, pageUrl } from "../src/api.js";

const files = ["server", "http", "browser"].map((source, index) => ({
  id: "file-" + index, date: "2026-10-30", source, instanceId: String(index + 1).repeat(32), segment: 1,
  name: source + "-" + String(index + 1).repeat(32) + "-1.jsonl", size: 1280, modifiedAt: "2026-10-30T04:00:00Z",
}));
const operationId = "b1234567-1234-4123-8123-123456789abc";
function page(file, params) {
  const line = params.get("line") === "last" ? 201 : Number(params.get("line") || Number(params.get("afterLine") || 0) + 1);
  const record = { time: "2026-10-30T12:00:00+08:00", event: "request_complete", level: "info", source: file.source, operation_id: operationId, text: '<img src="https://remote.invalid/x">' };
  return { file, revision: "revision-" + file.id, totalLines: 202, matchedLines: 202,
    entries: [{ line, raw: JSON.stringify(record), record, error: null, truncated: false }, { line: line + 1, raw: "{broken", record: null, error: "无法解析此行 JSON", truncated: false }],
    hasMore: line < 201, nextAfterLine: line + 1 };
}

async function mount(t, respond) {
  const window = new Window({ url: "http://127.0.0.1:5174/" });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, fetch: respond };
  const originals = new Map();
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close(); window.happyDOM.abort();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(App))); });
  async function click(element) { assert.ok(element); await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); }
  return { container, window, click };
}
function json(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }

test("workspace deduplicates batched opens, bounds tabs and selects a neighbor on close", () => {
  let state = workspaceReducer(initialWorkspace, { type: "open", file: files[0] });
  state = workspaceReducer(state, { type: "open", file: files[0] });
  assert.equal(state.tabs.length, 1);
  for (let index = 1; index <= 8; index++) state = workspaceReducer(state, { type: "open", file: { ...files[0], id: "extra-" + index } });
  assert.equal(state.tabs.length, 8); assert.match(state.notice, /最多/);
  const activeId = state.activeId;
  state = workspaceReducer(state, { type: "close", id: activeId });
  assert.equal(state.activeId, state.tabs.at(-1).id);
  assert.equal(state.tabs.length, 7);
});

test("client URLs encode literal search values and never accept a filesystem path", () => {
  const url = new URL(pageUrl("opaque/id", { filters: { q: "中文 & +", operationId }, target: { line: "last" }, revision: "signed+token" }), "http://127.0.0.1");
  assert.equal(url.pathname, "/api/logs/opaque%2Fid"); assert.equal(url.searchParams.get("q"), "中文 & +");
  assert.equal(url.searchParams.get("line"), "last"); assert.equal(url.searchParams.get("revision"), "signed+token");
  assert.equal(new URL(downloadUrl("opaque", "signed+token"), url).searchParams.get("revision"), "signed+token");
});

test("tabs retain panels and reading state; filtering, pagination, raw copy and refresh use only the log API", async (t) => {
  const requests = [];
  const { container, window, click } = await mount(t, async (input, options = {}) => {
    const url = new URL(String(input), "http://127.0.0.1"); requests.push({ url, signal: options.signal });
    if (url.pathname === "/api/logs") return json({ files, warnings: 0 });
    const file = files.find((value) => url.pathname === "/api/logs/" + value.id); assert.ok(file, "only the standalone log API is called");
    return json(page(file, url.searchParams));
  });
  await click(container.querySelectorAll(".file-item")[0]);
  const first = container.querySelector('[role="tabpanel"]');
  assert.equal(first.querySelectorAll(".record").length, 2);
  assert.match(first.textContent, /无法解析/);
  assert.equal(first.querySelectorAll("img,script").length, 0, "log content remains plain text");
  const records = first.querySelector(".records"); records.scrollTop = 350;
  const raw = first.querySelector("details"); raw.open = true;
  let copied = ""; Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  await click(first.querySelector(".record-actions button"));
  assert.match(copied, /request_complete/); assert.match(first.textContent, /已复制/);
  const readCount = requests.length;
  await click(container.querySelectorAll(".file-item")[1]);
  await click(container.querySelectorAll(".file-item")[0]);
  assert.equal(container.querySelectorAll('[role="tabpanel"]').length, 2);
  assert.equal(container.querySelector('[role="tabpanel"]'), first);
  assert.equal(records.scrollTop, 350); assert.equal(raw.open, true);
  const count = requests.length;
  await click(container.querySelectorAll(".file-item")[0]);
  assert.equal(requests.length, count, "reactivation starts no new request"); assert.ok(count > readCount);
  const level = first.querySelector(".filters select");
  await act(async () => { level.value = "error"; level.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await act(async () => first.querySelector(".filters").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(requests.at(-1).url.searchParams.get("level"), "error");
  assert.equal(requests.at(-1).url.searchParams.get("revision"), "revision-file-0");
  await click([...first.querySelectorAll(".page-bar button")].find((button) => button.textContent === "下一页"));
  assert.equal(requests.at(-1).url.searchParams.get("afterLine"), "2");
  await click([...first.querySelectorAll(".page-bar button")].find((button) => button.textContent === "上一页"));
  assert.equal(requests.at(-1).url.searchParams.get("afterLine"), "0");
  await click(first.querySelector(".correlations button"));
  assert.equal(requests.at(-1).url.searchParams.get("operationId"), operationId);
  assert.equal(first.querySelector(".heading-actions a").getAttribute("href"), downloadUrl(files[0].id, "revision-file-0"));
  await click(first.querySelector(".heading-actions button"));
  assert.equal(requests.at(-1).url.searchParams.has("revision"), false, "manual refresh acquires a fresh snapshot");
  await click(container.querySelector('[aria-label="关闭 ' + files[0].name + '"]'));
  assert.equal(container.querySelectorAll('[role="tabpanel"]').length, 1);
  assert.ok(requests.filter((value) => value.url.pathname === "/api/logs/file-0").every((value) => value.signal.aborted), "closing releases pending request lifetime");
});

test("409 preserves visible data; closing a pending panel aborts and discards a late response", async (t) => {
  let conflict = false; let pending = false; let resolvePending; let pendingSignal;
  const { container, window, click } = await mount(t, async (input, options = {}) => {
    const url = new URL(String(input), "http://127.0.0.1");
    if (url.pathname === "/api/logs") return json({ files, warnings: 0 });
    if (pending) { pendingSignal = options.signal; return new Promise((resolve) => { resolvePending = resolve; }); }
    if (conflict) return json({ error: "changed", code: "stale_revision" }, 409);
    return json(page(files[0], url.searchParams));
  });
  await click(container.querySelector(".file-item"));
  conflict = true;
  const panel = container.querySelector('[role="tabpanel"]');
  await click([...panel.querySelectorAll(".page-bar button")].find((button) => button.textContent === "下一页"));
  assert.match(panel.querySelector('[role="alert"]').textContent, /快照已变化/);
  assert.equal(panel.querySelectorAll(".record").length, 2);
  conflict = false; pending = true;
  await click(panel.querySelector(".heading-actions button"));
  await click(container.querySelector('[aria-label="关闭 ' + files[0].name + '"]'));
  assert.equal(pendingSignal.aborted, true);
  await act(async () => resolvePending(json(page(files[0], new URLSearchParams()))));
  assert.equal(container.querySelectorAll('[role="tabpanel"]').length, 0);
  assert.match(container.textContent, /选择一个日志文件/);
});
