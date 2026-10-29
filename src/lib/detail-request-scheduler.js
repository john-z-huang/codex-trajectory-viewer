function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function createDetailRequestScheduler(maxConcurrency = 2) {
  const queue = [];
  const active = new Set();
  let sequence = 0;
  let pumpScheduled = false;

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function pump() {
    queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    while (active.size < maxConcurrency && queue.length) {
      const task = queue.shift();
      if (task.state !== "queued") continue;
      task.state = "active";
      active.add(task);
      Promise.resolve()
        .then(() => {
          if (task.state !== "active") throw abortError();
          return task.run();
        })
        .then(
          (value) => finish(task, "resolved", value),
          (error) => finish(task, "rejected", error),
        );
    }
  }

  function finish(task, outcome, value) {
    if (task.state === "cancelled") {
      if (active.delete(task)) pump();
      return;
    }
    if (task.state !== "active") return;
    task.state = outcome;
    active.delete(task);
    if (outcome === "resolved") task.resolve(value);
    else task.reject(value);
    pump();
  }

  function enqueue(run, { priority = 0 } = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const task = { run, priority, sequence: sequence++, resolve, reject, state: "queued" };
    queue.push(task);
    schedulePump();

    return {
      promise,
      setPriority(nextPriority) {
        if (task.state !== "queued") return;
        task.priority = nextPriority;
        schedulePump();
      },
      cancel() {
        if (task.state !== "queued" && task.state !== "active") return;
        if (task.state === "queued") {
          const index = queue.indexOf(task);
          if (index >= 0) queue.splice(index, 1);
        }
        task.state = "cancelled";
        task.reject(abortError());
        if (active.has(task)) return;
        schedulePump();
      },
    };
  }

  return { enqueue, get activeCount() { return active.size; }, get pendingCount() { return queue.length; } };
}

export const detailRequestScheduler = createDetailRequestScheduler(2);
