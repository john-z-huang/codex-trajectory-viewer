import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function setup() {
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
  const vite = await createServer({
    configFile: new URL("../vite.config.js", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  const { useSessionDetail } = await vite.ssrLoadModule("/src/hooks/useSessionDetail.js");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  function Harness() {
    const [refreshVersion, setRefreshVersion] = useState(0);
    const value = useSessionDetail("synthetic-session", refreshVersion);
    return React.createElement("div", null,
      React.createElement("button", { onClick: () => setRefreshVersion((current) => current + 1) }, "refresh"),
      React.createElement("button", { onClick: () => value.loadHistoryPage(2) }, "history"),
      React.createElement("output", null, JSON.stringify({ detail: value.detail, error: value.error, loading: value.loading, historyLoading: value.historyLoading })));
  }
  return {
    container,
    root,
    Harness,
    unmount: async () => {
      if (unmounted) return;
      await act(async () => root.unmount());
      unmounted = true;
    },
    cleanup: async () => {
      await (async () => {
        if (!unmounted) {
          await act(async () => root.unmount());
          unmounted = true;
        }
      })();
      await vite.close();
      window.happyDOM.abort();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("stale detail and history responses that ignore abort cannot parse or replace current detail", async () => {
  const ui = await setup();
  const calls = [];
  globalThis.fetch = (url, options) => {
    const body = deferred();
    const pendingFetch = deferred();
    const call = { url: String(url), signal: options.signal, body, pendingFetch, jsonCalls: 0 };
    calls.push(call);
    return pendingFetch.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    assert.equal(calls.length, 1);
    const abandonedDetail = calls[0];
    await act(async () => {
      ui.container.querySelector("button").click();
      await Promise.resolve();
    });
    assert.equal(abandonedDetail.signal.aborted, true);
    assert.equal(calls.length, 2);
    abandonedDetail.pendingFetch.resolve({ ok: true, json: () => { abandonedDetail.jsonCalls += 1; return abandonedDetail.body.promise; } });
    await act(async () => Promise.resolve());
    assert.equal(abandonedDetail.jsonCalls, 0, "obsolete detail body is never parsed");

    const freshDetail = calls[1];
    freshDetail.pendingFetch.resolve({ ok: true, json: () => { freshDetail.jsonCalls += 1; return freshDetail.body.promise; } });
    await act(async () => Promise.resolve());
    freshDetail.body.resolve({ contents: "current detail", supplement: [{ page: 1 }] });
    await act(async () => Promise.resolve());
    await act(async () => ui.container.querySelectorAll("button")[1].click());
    assert.equal(calls.length, 3);
    const oldHistory = calls[2];
    oldHistory.pendingFetch.resolve({ ok: true, json: () => { oldHistory.jsonCalls += 1; return oldHistory.body.promise; } });
    await act(async () => Promise.resolve());
    await act(async () => {
      ui.container.querySelector("button").click();
      await Promise.resolve();
    });
    assert.equal(oldHistory.signal.aborted, true);
    assert.equal(calls.length, 4);
    oldHistory.body.resolve({ supplement: [{ page: "obsolete" }] });
    await act(async () => Promise.resolve());
    assert.equal(oldHistory.jsonCalls, 1, "the already-read history body is guarded after parsing");
    const beforeFreshDetail = JSON.parse(ui.container.querySelector("output").textContent);
    assert.deepEqual(beforeFreshDetail.detail.supplement, [{ page: 1 }]);
    assert.equal(beforeFreshDetail.loading, true);
    assert.equal(beforeFreshDetail.error, "");

    calls[3].pendingFetch.resolve({ ok: true, json: () => { calls[3].jsonCalls += 1; return calls[3].body.promise; } });
    await act(async () => Promise.resolve());
    calls[3].body.resolve({ contents: "refreshed detail", supplement: [{ page: "fresh" }] });
    await act(async () => Promise.resolve());
    assert.match(ui.container.querySelector("output").textContent, /refreshed detail/);
    assert.doesNotMatch(ui.container.querySelector("output").textContent, /obsolete/);
  } finally {
    await ui.cleanup();
  }
});

test("refresh prevents an already-parsing detail body from replacing newer detail", async () => {
  const ui = await setup();
  const calls = [];
  globalThis.fetch = (_url, options) => {
    const body = deferred();
    const pendingFetch = deferred();
    const call = { signal: options.signal, body, pendingFetch, jsonCalls: 0 };
    calls.push(call);
    return pendingFetch.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    const staleDetail = calls[0];
    staleDetail.pendingFetch.resolve({
      ok: true,
      json: () => { staleDetail.jsonCalls += 1; return staleDetail.body.promise; },
    });
    await act(async () => Promise.resolve());
    assert.equal(staleDetail.jsonCalls, 1, "the old detail JSON parse has begun");

    await act(async () => {
      ui.container.querySelector("button").click();
      await Promise.resolve();
    });
    assert.equal(staleDetail.signal.aborted, true);
    const freshDetail = calls[1];
    freshDetail.pendingFetch.resolve({
      ok: true,
      json: async () => ({ contents: "fresh after refresh", supplement: [{ page: "fresh" }] }),
    });
    await act(async () => Promise.resolve());
    let view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.equal(view.detail.contents, "fresh after refresh");
    assert.equal(view.loading, false);
    assert.equal(view.error, "");

    staleDetail.body.resolve({ contents: "stale late body", supplement: [{ page: "stale" }] });
    await act(async () => Promise.resolve());
    view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.equal(view.detail.contents, "fresh after refresh");
    assert.deepEqual(view.detail.supplement, [{ page: "fresh" }]);
    assert.equal(view.loading, false);
    assert.equal(view.error, "");
  } finally {
    await ui.cleanup();
  }
});

test("unmount aborts the detail request and a late fetch resolution never parses its body", async () => {
  const ui = await setup();
  const request = deferred();
  const body = deferred();
  let signal;
  let jsonCalls = 0;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return request.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    await ui.unmount();
    assert.equal(signal.aborted, true);
    request.resolve({ ok: true, json: () => { jsonCalls += 1; return body.promise; } });
    await act(async () => Promise.resolve());
    assert.equal(jsonCalls, 0);
  } finally {
    await ui.cleanup();
  }
});

test("current detail and history failures remain visible while stale abort failures stay silent", async () => {
  const ui = await setup();
  const calls = [];
  globalThis.fetch = (_url, options) => {
    const pendingFetch = deferred();
    const call = { signal: options.signal, pendingFetch };
    calls.push(call);
    return pendingFetch.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    await act(async () => {
      ui.container.querySelector("button").click();
      await Promise.resolve();
    });
    calls[0].pendingFetch.reject(new DOMException("Request was aborted", "AbortError"));
    calls[1].pendingFetch.resolve({ ok: false, status: 503 });
    await act(async () => Promise.resolve());
    let view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.equal(view.error, "会话读取失败（503）");
    assert.equal(view.loading, false);

    await act(async () => {
      ui.container.querySelector("button").click();
      await Promise.resolve();
    });
    const freshDetail = calls[2];
    freshDetail.pendingFetch.resolve({ ok: true, json: async () => ({ contents: "current", supplement: [] }) });
    await act(async () => Promise.resolve());
    await act(async () => ui.container.querySelectorAll("button")[1].click());
    calls[3].pendingFetch.resolve({ ok: false, status: 500 });
    await act(async () => Promise.resolve());
    view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.equal(view.error, "SQLite 历史读取失败（500）");
    assert.equal(view.historyLoading, false);
  } finally {
    await ui.cleanup();
  }
});

test("the latest of two competing history requests wins even when the earlier body resolves last", async () => {
  const ui = await setup();
  const calls = [];
  globalThis.fetch = (_url, options) => {
    const pendingFetch = deferred();
    const call = { signal: options.signal, pendingFetch };
    calls.push(call);
    return pendingFetch.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    calls[0].pendingFetch.resolve({ ok: true, json: async () => ({ contents: "initial", supplement: [{ page: 1 }] }) });
    await act(async () => Promise.resolve());
    await act(async () => ui.container.querySelectorAll("button")[1].click());
    const firstHistory = calls[1];
    const firstBody = deferred();
    firstHistory.pendingFetch.resolve({ ok: true, json: () => firstBody.promise });
    await act(async () => Promise.resolve());

    await act(async () => ui.container.querySelectorAll("button")[1].click());
    const latestHistory = calls[2];
    assert.equal(firstHistory.signal.aborted, true);
    latestHistory.pendingFetch.resolve({ ok: true, json: async () => ({ supplement: [{ page: "latest" }] }) });
    await act(async () => Promise.resolve());
    let view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.deepEqual(view.detail.supplement, [{ page: "latest" }]);

    firstBody.resolve({ supplement: [{ page: "earlier" }] });
    await act(async () => Promise.resolve());
    view = JSON.parse(ui.container.querySelector("output").textContent);
    assert.deepEqual(view.detail.supplement, [{ page: "latest" }]);
    assert.equal(view.historyLoading, false);
  } finally {
    await ui.cleanup();
  }
});

test("unmount aborts a pending history request", async () => {
  const ui = await setup();
  const calls = [];
  globalThis.fetch = (_url, options) => {
    const pendingFetch = deferred();
    calls.push({ signal: options.signal, pendingFetch });
    return pendingFetch.promise;
  };
  try {
    await act(async () => ui.root.render(React.createElement(ui.Harness)));
    calls[0].pendingFetch.resolve({ ok: true, json: async () => ({ contents: "loaded", supplement: [] }) });
    await act(async () => Promise.resolve());
    await act(async () => ui.container.querySelectorAll("button")[1].click());
    const historyRequest = calls[1];
    await ui.unmount();
    assert.equal(historyRequest.signal.aborted, true);
  } finally {
    await ui.cleanup();
  }
});
