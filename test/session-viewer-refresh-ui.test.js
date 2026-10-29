import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function settleReact() {
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
}

function windowPayload(session, text) {
  const raw = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
  const byteLength = new TextEncoder().encode(raw).byteLength;
  return {
    ...session,
    filename: `${session.id}.jsonl`,
    supplement: [],
    subagents: [],
    rollout: { revision: `revision-${text}`, totalLines: 1, totalBytes: byteLength, pageSize: 32, startLine: 1, endLine: 1, warnings: [] },
    lines: [{ lineNumber: 1, byteLength, raw }],
  };
}

test("刷新状态覆盖列表与全部详情请求，列表失败和关闭标签都能收敛", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  original.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));

  let vite;
  let root;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { SessionViewer } = await vite.ssrLoadModule("/src/components/SessionViewer.jsx");
    const host = window.document.createElement("div");
    window.document.body.append(host);
    root = createRoot(host);
    const listCalls = [];
    const detailCalls = [];
    globalThis.fetch = (url, options = {}) => {
      if (url === "/api/sessions") {
        if (listCalls.length === 4) return Promise.resolve({ ok: false, status: 503 });
        const call = { body: deferred() };
        listCalls.push(call);
        return Promise.resolve({ ok: true, json: () => call.body.promise });
      }
      const call = { url: String(url), signal: options.signal, body: deferred() };
      detailCalls.push(call);
      if (detailCalls.length === 4) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({ ok: true, json: () => call.body.promise });
    };

    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(SessionViewer))));
    await settleReact();
    assert.equal(listCalls.length, 1);
    listCalls[0].body.resolve([{
      id: "synthetic-session-id",
      sessionId: "synthetic-thread-id",
      title: "Synthetic session",
      cwd: "/synthetic/project",
      archived: false,
      timestamp: "2026-10-29T00:00:00Z",
    }]);
    await settleReact();
    assert.equal(detailCalls.length, 1);
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");
    assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /正在读取会话/);
    detailCalls[0].body.resolve(windowPayload({
      sessionId: "synthetic-thread-id",
      id: "synthetic-session-id",
      title: "Synthetic session",
      filename: "synthetic.jsonl",
    }, "initial detail"));
    await settleReact();
    assert.match(host.querySelector('[role="tabpanel"]')?.textContent ?? "", /initial detail/, "valid window payload renders the initial record");
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新");

    await act(async () => host.querySelector(".refresh-button").click());
    await settleReact();
    assert.equal(listCalls.length, 2);
    assert.equal(detailCalls.length, 2);
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");

    const oldPanelTabId = host.querySelector('.session-tabs [role="tab"]').id;
    await act(async () => {
      host.querySelector(".session-tab-close").click();
      host.querySelector(".session-list .session-item").click();
    });
    await settleReact();
    assert.equal(detailCalls.length, 3, "reopening the same session creates a distinct panel request");
    assert.equal(detailCalls[1].signal.aborted, true);
    assert.equal(host.querySelector('.session-tabs [role="tab"]').id === oldPanelTabId, false);
    detailCalls[1].body.resolve(windowPayload({ id: "synthetic-session-id", sessionId: "synthetic-thread-id", title: "Synthetic session" }, "late old panel"));
    await settleReact();
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…", "late settlement from the closed tab cannot clear its replacement");
    assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /正在读取会话/);

    listCalls[1].body.resolve([{ id: "synthetic-session-id", sessionId: "synthetic-thread-id", title: "Synthetic session", cwd: "/synthetic/project" }]);
    await settleReact();
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…", "the batch still waits for the replacement panel");
    detailCalls[2].body.resolve(windowPayload({
      sessionId: "synthetic-thread-id",
      id: "synthetic-session-id",
      title: "Synthetic session",
      filename: "synthetic.jsonl",
    }, "replacement detail"));
    await settleReact();
    assert.match(host.querySelector('[role="tabpanel"]')?.textContent ?? "", /replacement detail/, "replacement window data is rendered after refresh");
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新");

    await act(async () => host.querySelector(".refresh-button").click());
    await settleReact();
    assert.equal(listCalls.length, 3);
    assert.equal(detailCalls.length, 4);
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");
    listCalls[2].body.resolve([{ id: "synthetic-session-id", sessionId: "synthetic-thread-id", title: "Synthetic session", cwd: "/synthetic/project" }]);
    await settleReact();
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新", "a failed detail response settles the refresh batch");
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /会话读取失败（503）/);

    await act(async () => host.querySelector(".refresh-button").click());
    await settleReact();
    assert.equal(listCalls.length, 4);
    assert.equal(detailCalls.length, 5);
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");
    await act(async () => host.querySelector(".session-tab-close").click());
    assert.equal(detailCalls[4].signal.aborted, true);
    listCalls[3].body.resolve([{ id: "synthetic-session-id", sessionId: "synthetic-thread-id", title: "Synthetic session", cwd: "/synthetic/project" }]);
    await settleReact();
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新", "closing a panel settles its pending refresh work");
    detailCalls[4].body.resolve(windowPayload({ id: "synthetic-session-id", sessionId: "synthetic-thread-id", title: "Synthetic session" }, "late"));
    await settleReact();

    await act(async () => host.querySelector(".refresh-button").click());
    await settleReact();
    assert.equal(listCalls.length, 4, "the next list request fails before creating a deferred body");
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新");
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /503/);
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

test("10 个打开标签刷新时 JSON body 并发不超过两个，全部 settle 后才结束批次", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  original.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));

  const sessions = Array.from({ length: 10 }, (_, index) => ({
    id: `synthetic-session-${index}`,
    sessionId: `synthetic-thread-${index}`,
    title: `Synthetic session ${index}`,
    cwd: "/synthetic/project",
    timestamp: `2026-10-29T00:00:${String(index).padStart(2, "0")}Z`,
  }));
  const refreshCalls = [];
  let refreshMode = false;
  let activeBodies = 0;
  let maxActiveBodies = 0;
  let vite;
  let root;
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { SessionViewer } = await vite.ssrLoadModule("/src/components/SessionViewer.jsx");
    const host = window.document.createElement("div");
    window.document.body.append(host);
    root = createRoot(host);
    globalThis.fetch = (input, options = {}) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/sessions") return Promise.resolve({ ok: true, json: async () => sessions });
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      const session = sessions.find((item) => item.id === id);
      if (!session) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "missing synthetic session" }) });
      if (url.searchParams.get("view") === "window" && refreshMode) {
        const body = deferred();
        const call = { id, signal: options.signal, body, started: false, resolved: false };
        refreshCalls.push(call);
        return Promise.resolve({
          ok: true,
          json: () => {
            call.started = true;
            activeBodies += 1;
            maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
            return body.promise.finally(() => { activeBodies -= 1; });
          },
        });
      }
      if (url.searchParams.get("view") === "window") {
        return Promise.resolve({ ok: true, json: async () => windowPayload(session, `initial ${session.title}`) });
      }
      if (url.searchParams.get("view") === "history") return Promise.resolve({ ok: true, json: async () => ({ supplement: [] }) });
      return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "unexpected synthetic view" }) });
    };

    await act(async () => {
      root.render(React.createElement(SessionViewer));
      await settleReact();
    });
    for (let index = 1; index < sessions.length; index += 1) {
      const row = host.querySelector(`[aria-label="打开会话：Synthetic session ${index}"]`);
      assert.ok(row, `session ${index} is present in the synthetic sidebar`);
      await act(async () => {
        row.click();
        await settleReact();
      });
    }
    assert.equal(host.querySelectorAll('.session-tabs [role="tab"]').length, 10);
    assert.equal(host.querySelectorAll('[role="tabpanel"] .event-card').length, 10);

    refreshMode = true;
    await act(async () => {
      host.querySelector(".refresh-button").click();
      await settleReact();
    });
    assert.equal(refreshCalls.length, 2, "only two scheduled window bodies start while the others remain queued");
    assert.equal(activeBodies, 2);
    assert.equal(maxActiveBodies, 2);
    assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");

    let settled = 0;
    while (settled < sessions.length) {
      const next = refreshCalls.find((call) => call.started && !call.resolved);
      assert.ok(next, `a refresh body is in flight before settling request ${settled + 1}`);
      next.resolved = true;
      next.body.resolve(windowPayload(sessions.find((session) => session.id === next.id), `refreshed ${next.id}`));
      settled += 1;
      await settleReact();
      assert.ok(activeBodies <= 2, "JSON parsing and body settlement stay within the scheduler's two slots");
      assert.ok(maxActiveBodies <= 2);
      if (settled < sessions.length) assert.equal(host.querySelector(".refresh-button").textContent, "刷新中…");
    }

    assert.equal(refreshCalls.length, 10);
    assert.equal(activeBodies, 0);
    assert.equal(host.querySelector(".refresh-button").textContent, "↻　刷新");
    const refreshedCards = [...host.querySelectorAll('[role="tabpanel"] .event-card')];
    assert.equal(refreshedCards.length, 10);
    for (const card of refreshedCards) assert.match(card.textContent, /refreshed synthetic-session-/);
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
