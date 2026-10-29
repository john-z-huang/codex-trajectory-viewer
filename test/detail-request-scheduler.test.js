import assert from "node:assert/strict";
import test from "node:test";
import { createDetailRequestScheduler } from "../src/lib/detail-request-scheduler.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("详情调度器限制 body 解析期间的并发并优先启动活动面板", async () => {
  const scheduler = createDetailRequestScheduler(2);
  const started = [];
  const bodies = new Map();
  const enqueue = (name, priority) => {
    const body = deferred();
    bodies.set(name, body);
    return scheduler.enqueue(async () => {
      started.push(name);
      const response = { json: () => body.promise };
      return response.json();
    }, { priority });
  };

  const backgroundA = enqueue("background-a", 0);
  const backgroundB = enqueue("background-b", 0);
  const active = enqueue("active", 1);
  await flush();

  assert.deepEqual(started, ["active", "background-a"]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.pendingCount, 1);
  bodies.get("active").resolve({ id: "active" });
  assert.deepEqual(await active.promise, { id: "active" });
  await flush();
  assert.deepEqual(started, ["active", "background-a", "background-b"]);
  assert.equal(scheduler.activeCount, 2, "the next request starts only after JSON body parsing settles");

  bodies.get("background-a").resolve({ id: "background-a" });
  bodies.get("background-b").resolve({ id: "background-b" });
  await Promise.all([backgroundA.promise, backgroundB.promise]);
  assert.equal(scheduler.activeCount, 0);
});

test("取消排队任务不会启动，在途任务直到 body settle 才释放调度 slot", async () => {
  const scheduler = createDetailRequestScheduler(2);
  const bodies = new Map(["a", "b", "cancelled", "third"].map((name) => [name, deferred()]));
  const started = [];
  const enqueue = (name) => scheduler.enqueue(() => {
    started.push(name);
    return bodies.get(name).promise;
  });
  const activeA = enqueue("a");
  const activeB = enqueue("b");
  const queued = enqueue("cancelled");
  const third = enqueue("third");
  await flush();
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.pendingCount, 2);

  queued.cancel();
  await assert.rejects(queued.promise, { name: "AbortError" });
  activeA.cancel();
  await assert.rejects(activeA.promise, { name: "AbortError" });
  await flush();

  assert.deepEqual(started, ["a", "b"], "the third request cannot start while the cancelled body is unresolved");
  assert.equal(scheduler.activeCount, 2, "cancelled fetch/body still owns its physical slot until it settles");
  assert.equal(scheduler.pendingCount, 1);
  bodies.get("a").resolve("late body");
  await flush();
  assert.deepEqual(started, ["a", "b", "third"]);
  bodies.get("b").resolve("b body");
  bodies.get("third").resolve("third body");
  await Promise.all([activeB.promise, third.promise]);
  assert.equal(scheduler.activeCount, 0);
});
