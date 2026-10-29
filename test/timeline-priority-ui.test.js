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

async function flushReact() {
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
}

async function waitForTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeEntry(sessionId, revision = "revision-1", oversized = false) {
  return {
    lineNumber: 1,
    timestamp: "2026-10-29T00:00:00Z",
    kind: oversized ? "oversized" : "user",
    title: `${sessionId} line`,
    ...(oversized ? { projectionLimited: true } : { text: "Synthetic user content", markdown: true }),
    originalLocator: { revision, sessionId },
  };
}

test("后台 raw/copy 保持低优先级，标签激活后提升排队任务；raw 关闭等待迟到 body settle 才释放槽", async () => {
  const window = new Window({ url: "http://localhost/" });
  const original = new Map();
  const calls = [];
  let activeBodies = 0;
  let maxActiveBodies = 0;
  const copiedRaw = JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic copy body" }] },
  });
  const fetchSyntheticView = (input, options = {}) => {
    const url = new URL(String(input), "http://localhost/");
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    const view = url.searchParams.get("view");
    const call = { id, view, signal: options.signal, body: deferred(), started: false, resolved: false };
    calls.push(call);
    return Promise.resolve({
      ok: true,
      json: () => {
        call.started = true;
        activeBodies += 1;
        maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
        const value = view === "raw"
          ? { offset: 0, nextOffset: 2, byteLength: 2, done: true, raw: "{}" }
          : { ok: true };
        return call.body.promise.then(() => value).finally(() => { activeBodies -= 1; });
      },
      text: () => {
        call.started = true;
        activeBodies += 1;
        maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
        return call.body.promise.then(() => copiedRaw).finally(() => { activeBodies -= 1; });
      },
    });
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchSyntheticView,
  };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  });
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let vite;
  const roots = new Map();
  try {
    vite = await createServer({
      configFile: new URL("../vite.config.js", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    const { Timeline } = await vite.ssrLoadModule("/src/components/Timeline.jsx");
    const host = window.document.createElement("div");
    for (const id of ["blocker-1", "blocker-2", "raw-a", "raw-b", "copy-c"]) {
      const panel = window.document.createElement("section");
      panel.className = "session-tab-panel";
      panel.dataset.panel = id;
      host.append(panel);
      roots.set(id, createRoot(panel));
    }
    window.document.body.append(host);

    const render = (id, { active, oversized = false }) => roots.get(id).render(React.createElement(Timeline, {
      entries: [makeEntry(id, "revision-1", oversized)],
      sessionId: id,
      active,
      rollout: { revision: "revision-1", totalLines: 1, pageSize: 32, startLine: 1 },
    }));
    const panel = (id) => host.querySelector(`[data-panel="${id}"]`);
    const openRaw = async (id) => {
      await act(async () => {
        panel(id).querySelector("details summary").click();
        await waitForTurn();
      });
    };
    const waitForCallCount = async (count) => {
      for (let attempt = 0; attempt < 8 && calls.length < count; attempt += 1) await flushReact();
      assert.equal(calls.length, count, `expected ${count} started fetches, received ${calls.length}`);
    };

    await act(async () => {
      render("blocker-1", { active: true });
      render("blocker-2", { active: true });
      render("raw-a", { active: false });
      render("raw-b", { active: false });
      render("copy-c", { active: false, oversized: true });
    });
    await openRaw("blocker-1");
    await waitForCallCount(1);
    await openRaw("blocker-2");
    await waitForCallCount(2);
    assert.deepEqual(calls.map(({ id, view }) => [id, view]), [["blocker-1", "raw"], ["blocker-2", "raw"]]);
    assert.equal(activeBodies, 2);

    await openRaw("raw-a");
    await openRaw("raw-b");
    await flushReact();
    assert.equal(calls.length, 2, "background raw requests stay queued behind the two pending bodies");

    await act(async () => {
      render("raw-b", { active: true });
      await waitForTurn();
    });
    calls[0].resolved = true;
    calls[0].body.resolve();
    await waitForCallCount(3);
    assert.deepEqual(calls[2] && [calls[2].id, calls[2].view], ["raw-b", "raw"], "an inactive raw request promoted on tab activation starts before older background work");

    const rawBCard = panel("raw-b").querySelector(".event-card");
    await act(async () => {
      rawBCard.querySelector("details summary").click();
      await waitForTurn();
    });
    assert.equal(calls[2].signal.aborted, true, "closing raw cancels its fetch");
    assert.equal(activeBodies, 2, "the aborted response body still owns its scheduler slot until settle");

    await act(async () => {
      panel("copy-c").querySelector('[aria-label="复制对话"]').click();
      await waitForTurn();
    });
    assert.equal(calls.length, 3, "background full copy remains queued while both bodies are pending");
    await act(async () => {
      render("copy-c", { active: true, oversized: true });
      await waitForTurn();
    });

    calls[1].resolved = true;
    calls[1].body.resolve();
    await waitForCallCount(4);
    assert.deepEqual(calls[3] && [calls[3].id, calls[3].view], ["copy-c", "download"], "a queued copy is promoted when its tab becomes active");
    assert.equal(activeBodies, 2, "late cancelled raw parsing continues to count against the concurrency limit");
    assert.equal(maxActiveBodies, 2);

    calls[2].resolved = true;
    calls[2].body.resolve();
    await waitForCallCount(5);
    assert.deepEqual(calls[4] && [calls[4].id, calls[4].view], ["raw-a", "raw"], "the remaining background raw request starts only after the cancelled body settles");
    assert.ok(maxActiveBodies <= 2);
  } finally {
    for (const call of calls) {
      if (!call.resolved) {
        call.resolved = true;
        call.body.resolve();
      }
    }
    await flushReact();
    for (const root of roots.values()) await act(async () => root.unmount());
    if (vite) await vite.close();
    window.happyDOM.abort();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
