import test from "node:test";
import assert from "node:assert/strict";
import { browserLogger, createBrowserLogger, createLogId, initializeBrowserLogger, safeBrowserError } from "../src/lib/logger.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const accepted = () => ({ ok: true, status: 200, json: async () => ({ persisted: true }) });

test("浏览器单例默认关闭，字段白名单排除正文、错误文本和非法关联 ID", async () => {
  assert.equal(browserLogger.log("browser_copy", { action: "start" }), false);
  const calls = [];
  const logger = createBrowserLogger({ fetchImpl: async (url, options) => { calls.push({ url, options }); return accepted(); } });
  const operationId = createLogId();
  const requestId = createLogId();
  try {
    for (const event of ["unknown", "__proto__", "constructor", "toString"]) assert.equal(logger.log(event), false);
    logger.log("browser_source", { action: "switch", data_source: "sqlite", title: "PRIVATE_SENTINEL", source: "PRIVATE_SENTINEL" }, { operation_id: operationId, request_id: requestId, tab_id: "PRIVATE_SENTINEL" });
    logger.log("browser_error", { ...safeBrowserError(new Error("PRIVATE_SENTINEL")), error_code: "window_error", message: "PRIVATE_SENTINEL" });
    await logger.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/logs");
    const [source, error] = JSON.parse(calls[0].options.body).events;
    assert.equal(source.data_source, "sqlite");
    assert.equal(source.operation_id, operationId);
    assert.equal(source.request_id, requestId);
    assert.equal(source.tab_id, undefined);
    assert.equal(error.error_type, "Error");
    assert.doesNotMatch(calls[0].options.body, /PRIVATE_SENTINEL/);
    assert.equal(logger.status().queued, 0);
  } finally { await logger.close(); }
});

test("浏览器队列有界，达到 20 条触发单独上报，同时最多一个请求", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const logger = createBrowserLogger({ fetchImpl: async (_url, { signal, body }) => {
    calls += 1;
    maximum = Math.max(maximum, ++active);
    assert.ok(Buffer.byteLength(body) <= 64 * 1024);
    assert.ok(JSON.parse(body).events.length <= 50);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { active -= 1; reject(new Error("aborted")); }, { once: true }));
  } });
  try {
  for (let i = 0; i < 250; i += 1) logger.log("browser_copy", { action: "start" });
  await tick();
  assert.equal(calls, 1);
  assert.equal(maximum, 1);
  assert.equal(logger.status().queued, 200);
  assert.ok(logger.status().queuedBytes <= 256 * 1024);
  assert.equal(logger.status().dropped, 50);
  const pending = logger.flush();
  assert.equal(logger.flush(), pending);
  await logger.close();
  assert.equal(await pending, false);
  assert.equal(logger.status().queued, 0);
  assert.equal(logger.log("browser_copy", { action: "start" }), false);
  } finally { await logger.close(); }
});

test("上报失败有限重试，重试保持 event_id，并且不记录自身请求", async () => {
  const ids = [];
  const logger = createBrowserLogger({
    fetchImpl: async (_url, { body }) => { ids.push(JSON.parse(body).events.map((event) => event.event_id)); throw new Error("PRIVATE_TRANSPORT_ERROR"); },
    setTimer: (callback, delay) => setTimeout(callback, delay < 1000 ? 0 : delay),
  });
  try {
    logger.log("browser_copy", { action: "start" });
    assert.equal(await logger.flush(), false);
    assert.equal(ids.length, 3);
    assert.deepEqual(ids[0], ids[1]);
    assert.deepEqual(ids[1], ids[2]);
    assert.equal(logger.status().queued, 0);
    assert.equal(logger.status().dropped, 1);
  } finally { await logger.close(); }
});

test("挂起上报有超时，close 取消重试和定时器且不重启队列", async () => {
  const handles = new Set();
  const signals = [];
  const logger = createBrowserLogger({
    fetchImpl: async (_url, { signal }) => { signals.push(signal); return new Promise(() => {}); },
    requestTimeoutMs: 5,
    setTimer: (callback, delay) => {
      const handle = setTimeout(() => { handles.delete(handle); callback(); }, delay >= 200 && delay < 1000 ? 0 : delay);
      handles.add(handle);
      return handle;
    },
    clearTimer: (handle) => { handles.delete(handle); clearTimeout(handle); },
  });
  logger.log("browser_copy", { action: "start" });
  assert.equal(await logger.flush(), false);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
  await logger.close();
  await tick();
  assert.equal(handles.size, 0);
});

test("发送确认不明时不把上报当作持久化成功，页面退出仅尽力入队", async () => {
  let beaconCalls = 0;
  let calls = 0;
  const logger = createBrowserLogger({
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ persisted: false }) }; },
    setTimer: (callback, delay) => setTimeout(callback, delay < 1000 ? 0 : delay),
    sendBeacon: () => { beaconCalls += 1; return true; },
  });
  try {
    logger.log("browser_download", { action: "dispatch", outcome: "dispatched", line: 1 });
    assert.equal(await logger.flush(), false);
    assert.equal(calls, 3);
    assert.equal(logger.status().dropped, 1);
    logger.log("browser_download", { action: "local_dispatch", outcome: "dispatched", line: 2 });
    assert.equal(logger.flushOnPageHide(), true);
    assert.equal(beaconCalls, 1);
    assert.equal(logger.status().queued, 0);
  } finally { await logger.close(); }
});

test("低频事件在 2 秒触发，上报积压按 50 条分批且保持顺序", async () => {
  const timers = new Map();
  const batches = [];
  const logger = createBrowserLogger({
    fetchImpl: async (_url, { body }) => { batches.push(JSON.parse(body).events); return accepted(); },
    setTimer: (callback, delay) => { const handle = {}; timers.set(handle, { callback, delay }); return handle; },
    clearTimer: (handle) => timers.delete(handle),
  });
  try {
    logger.log("browser_copy", { action: "start" });
    assert.equal(batches.length, 0);
    const [handle, timeout] = [...timers][0];
    assert.equal(timeout.delay, 2000);
    timers.delete(handle);
    timeout.callback();
    await logger.flush();
    assert.equal(batches.length, 1);
    for (let i = 0; i < 130; i += 1) logger.log("browser_copy", { action: "start" });
    while (logger.status().queued) await logger.flush();
    assert.deepEqual(batches.slice(1).map((batch) => batch.length), [20, 50, 50, 10]);
    const sequences = batches.flat().map((event) => event.client_seq);
    assert.deepEqual(sequences, Array.from({ length: 131 }, (_, index) => index + 1));
  } finally { await logger.close(); }
});

test("重复初始化只安装一组生命周期与错误监听，不读取异常正文", async () => {
  class Surface extends EventTarget {
    installed = [];
    addEventListener(type, ...args) { this.installed.push(type); super.addEventListener(type, ...args); }
  }
  const window = new Surface();
  const document = new Surface();
  document.visibilityState = "visible";
  const descriptors = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const originalLog = browserLogger.log;
  const events = [];
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    browserLogger.log = (event, fields) => { events.push({ event, ...fields }); return false; };
    assert.equal(initializeBrowserLogger(), true);
    assert.equal(initializeBrowserLogger(), false);
    assert.deepEqual(window.installed.sort(), ["error", "pagehide", "unhandledrejection"]);
    assert.deepEqual(document.installed, ["visibilitychange"]);
    const error = new Event("error");
    error.error = new Error("PRIVATE_RUNTIME_ERROR");
    window.dispatchEvent(error);
    const rejection = new Event("unhandledrejection");
    rejection.reason = { private: "PRIVATE_RUNTIME_ERROR" };
    window.dispatchEvent(rejection);
    assert.equal(events.length, 2);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RUNTIME_ERROR/);
    assert.deepEqual(events.map((event) => event.error_code), ["window_error", "unhandled_rejection"]);
  } finally {
    browserLogger.log = originalLog;
    await browserLogger.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
