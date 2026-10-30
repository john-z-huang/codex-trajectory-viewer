import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAppLogger,
  createFileLogger,
  DEFAULT_LOG_LIMITS,
} from "../server-dist/logger.js";

const FIXED_INSTANCE_IDS = "abcdef0123456789abcdef0123456789";
const validUuid = "123e4567-e89b-42d3-a456-426614174000";

async function makePaths(t) {
  const tempRoot = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(tempRoot, "ctv-logger-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    root: path.join(base, "log-root"),
    home: path.join(base, "codex-home"),
    sqliteHome: path.join(base, "sqlite-home"),
  };
}

function hostDate(date) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function dateDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
}

async function logFiles(root) {
  const result = [];
  for (const day of await dateDirectories(root)) {
    for (const entry of await readdir(day.path, { withFileTypes: true })) {
      if (/^(server|http|browser)-[a-f0-9]{32}-\d+\.jsonl$/.test(entry.name) && entry.isFile()) {
        result.push(path.join(day.path, entry.name));
      }
    }
  }
  return result.sort();
}

async function recordsAt(root) {
  const records = [];
  for (const file of await logFiles(root)) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) if (line) records.push(JSON.parse(line));
  }
  return records;
}

async function regularFileBytes(root) {
  let total = 0;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const item = path.join(directory, entry.name);
      const info = await lstat(item);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(item);
      else if (info.isFile() && info.nlink === 1) total += info.size;
    }
  };
  await visit(root);
  return total;
}

async function findLogForInstance(root, instanceId) {
  return (await logFiles(root)).find((file) => path.basename(file).includes(`-${instanceId}-`));
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function memorySink(onWrite = async () => undefined) {
  const records = [];
  let closeCount = 0;
  return {
    records,
    sink: {
      async write(record, serialized) {
        await onWrite(record, serialized);
        records.push(JSON.parse(serialized));
      },
      async close() { closeCount += 1; },
      get closeCount() { return closeCount; },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function waitForAsync(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function snapshot(files) {
  const pairs = await Promise.all(files.map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")]));
  return Object.fromEntries(pairs);
}

test("logging defaults retain the 10 MiB, 14 day, and 512 MiB limits", () => {
  assert.deepEqual(DEFAULT_LOG_LIMITS, {
    maxFileBytes: 10 * 1024 * 1024,
    retentionDays: 14,
    maxTotalBytes: 512 * 1024 * 1024,
    maxQueueEvents: 1000,
    maxQueueBytes: 1024 * 1024,
    closeTimeoutMs: 1500,
  });
});

test("file logger partitions by host-local date and rotates bounded files", async (t) => {
  const paths = await makePaths(t);
  const jan2 = new Date(2007, 0, 2, 23, 59, 59);
  const jan3 = new Date(2007, 0, 3, 0, 0, 1);
  const times = [jan2, jan2, jan3, jan3];
  let index = 0;
  const logger = createFileLogger({
    ...paths,
    instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clock: () => times[Math.min(index++, times.length - 1)],
    limits: { maxFileBytes: 512 },
  });
  t.after(() => logger.close());
  for (let event = 0; event < 20; event += 1) logger.emit("server_start");
  await logger.close();

  const files = await logFiles(paths.root);
  assert.ok(files.length > 2, "multiple segments should be created across the two days and size limit");
  assert.deepEqual((await dateDirectories(paths.root)).map((entry) => entry.name).sort(), ["2007-01-02", "2007-01-03"]);
  assert.equal((await recordsAt(paths.root)).length, 20);
  for (const file of files) assert.ok((await stat(file)).size <= 512, `${path.basename(file)} exceeded its injected limit`);

  const offsetDate = new Date("2026-10-30T23:30:00-11:00");
  const offsetLogger = createFileLogger({
    ...paths,
    instanceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    clock: () => offsetDate,
  });
  t.after(() => offsetLogger.close());
  offsetLogger.emit("server_start");
  await offsetLogger.close();
  assert.ok((await dateDirectories(paths.root)).some((entry) => entry.name === hostDate(offsetDate)), "offset timestamps use the machine's local calendar date");
});

test("retention deletes only owned closed segments and preserves unknown, linked, and active files", async (t) => {
  const paths = await makePaths(t);
  const oldDate = new Date(2026, 4, 17, 12);
  const cutoffDate = new Date(2026, 4, 19, 12);
  const today = new Date(2026, 4, 20, 12);
  const retention = { retentionDays: 2 };

  const oldLogger = createFileLogger({ ...paths, instanceId: "11111111111111111111111111111111", clock: () => oldDate, limits: retention });
  oldLogger.emit("server_start");
  await oldLogger.close();
  const oldOwnedFile = await findLogForInstance(paths.root, "11111111111111111111111111111111");
  assert.ok(oldOwnedFile);

  const boundaryLogger = createFileLogger({ ...paths, instanceId: "22222222222222222222222222222222", clock: () => cutoffDate, limits: retention });
  boundaryLogger.emit("server_start");
  await boundaryLogger.close();
  const boundaryFile = await findLogForInstance(paths.root, "22222222222222222222222222222222");
  assert.ok(boundaryFile);

  const activeLogger = createFileLogger({ ...paths, instanceId: "33333333333333333333333333333333", clock: () => oldDate, limits: retention });
  t.after(() => activeLogger.close());
  activeLogger.emit("server_start");
  await waitForAsync(() => findLogForInstance(paths.root, "33333333333333333333333333333333"), "active segment was not created");
  const activeFile = await findLogForInstance(paths.root, "33333333333333333333333333333333");
  assert.ok(activeFile);

  const oldDirectory = path.dirname(oldOwnedFile);
  const unknownFile = path.join(oldDirectory, `http-${"d".repeat(32)}-9.jsonl`);
  const hardlinkFile = path.join(oldDirectory, `server-${"e".repeat(32)}-9.jsonl`);
  const symlinkFile = path.join(oldDirectory, `browser-${"f".repeat(32)}-9.jsonl`);
  const hardlinkTarget = path.join(paths.base, "outside-hardlink-target.txt");
  const symlinkTarget = path.join(paths.base, "outside-symlink-target.txt");
  await writeFile(unknownFile, "unknown but must remain\n");
  await writeFile(hardlinkTarget, "hardlink target must remain\n");
  await link(hardlinkTarget, hardlinkFile);
  await writeFile(symlinkTarget, "symlink target must remain\n");
  await symlink(symlinkTarget, symlinkFile);

  const currentLogger = createFileLogger({ ...paths, instanceId: "44444444444444444444444444444444", clock: () => today, limits: retention });
  t.after(() => currentLogger.close());
  currentLogger.emit("server_start");
  await currentLogger.close();

  assert.equal(await exists(oldOwnedFile), false, "old, owned, closed log segment should be removed");
  assert.equal(await exists(path.join(path.dirname(oldOwnedFile), `.owner-${path.basename(oldOwnedFile)}`)), false);
  assert.equal(await exists(activeFile), true, "an active segment from another logger must remain");
  assert.equal(await exists(path.join(path.dirname(activeFile), `.active-${path.basename(activeFile)}`)), true);
  assert.equal(await exists(boundaryFile), true, "the first retained calendar day must remain");
  assert.equal(await exists(unknownFile), true, "a matching filename without owner metadata must remain");
  assert.equal((await lstat(hardlinkFile)).nlink, 2, "a hard-linked log must not be removed");
  assert.equal((await lstat(symlinkFile)).isSymbolicLink(), true, "a symlinked log must not be followed or removed");
  assert.equal(await readFile(symlinkTarget, "utf8"), "symlink target must remain\n");
  assert.equal(await readFile(hardlinkTarget, "utf8"), "hardlink target must remain\n");
});

test("total budget reclaims the oldest closed owned segment without touching an active segment", async (t) => {
  const paths = await makePaths(t);
  const day = new Date(2026, 6, 15, 12);
  const oldLogger = createFileLogger({ ...paths, instanceId: "55555555555555555555555555555555", clock: () => day });
  for (let i = 0; i < 20; i += 1) oldLogger.emit("server_start");
  await oldLogger.close();
  const oldFile = await findLogForInstance(paths.root, "55555555555555555555555555555555");
  assert.ok(oldFile);

  const activeLogger = createFileLogger({ ...paths, instanceId: "66666666666666666666666666666666", clock: () => day });
  t.after(() => activeLogger.close());
  activeLogger.emit("server_start");
  await waitForAsync(() => findLogForInstance(paths.root, "66666666666666666666666666666666"), "active budget fixture was not created");
  const activeFile = await findLogForInstance(paths.root, "66666666666666666666666666666666");
  assert.ok(activeFile);

  const budget = 2048;
  assert.ok(await regularFileBytes(paths.root) > budget, "fixture should exceed the injected shared root budget");
  const boundedLogger = createFileLogger({
    ...paths,
    instanceId: "77777777777777777777777777777777",
    clock: () => day,
    limits: { maxTotalBytes: budget },
  });
  t.after(() => boundedLogger.close());
  boundedLogger.emit("server_shutdown");
  await boundedLogger.close();

  assert.equal(await exists(oldFile), false, "oldest closed segment should be reclaimed to satisfy the budget");
  assert.equal(await exists(activeFile), true, "an active segment cannot be reclaimed");
  assert.ok(await findLogForInstance(paths.root, "77777777777777777777777777777777"));
});

test("root overlap and symlink aliases reject before creating files and keep synthetic Codex fixtures byte-identical", async (t) => {
  const paths = await makePaths(t);
  const rollout = path.join(paths.home, "sessions", "2026", "10", "30", "synthetic.jsonl");
  const database = path.join(paths.home, "state_5.sqlite");
  const wal = `${database}-wal`;
  const shm = `${database}-shm`;
  const separateDatabase = path.join(paths.sqliteHome, "thread_history_1.sqlite");
  await mkdir(path.dirname(rollout), { recursive: true });
  await mkdir(paths.sqliteHome, { recursive: true });
  await writeFile(rollout, '{"type":"session_meta","payload":{"id":"synthetic"}}\n');
  await writeFile(database, "synthetic sqlite bytes\n");
  await writeFile(wal, "synthetic wal bytes\n");
  await writeFile(shm, "synthetic shm bytes\n");
  await writeFile(separateDatabase, "synthetic separate database bytes\n");
  const fixtureFiles = [rollout, database, wal, shm, separateDatabase];
  const before = await snapshot(fixtureFiles);

  const outside = path.join(paths.base, "outside");
  await mkdir(outside);
  const aliasToHome = path.join(paths.base, "home-alias");
  const aliasOutside = path.join(paths.base, "outside-alias");
  await symlink(paths.home, aliasToHome);
  await symlink(outside, aliasOutside);

  const unsafeRoots = [
    { name: "nested under CODEX_HOME", root: path.join(paths.home, "logs"), target: path.join(paths.home, "logs") },
    { name: "nested under CODEX_SQLITE_HOME", root: path.join(paths.sqliteHome, "logs"), target: path.join(paths.sqliteHome, "logs") },
    { name: "missing descendant through a symlink to CODEX_HOME", root: path.join(aliasToHome, "new", "logs"), target: path.join(paths.home, "new", "logs") },
    { name: "missing descendant through another symlink ancestor", root: path.join(aliasOutside, "new", "logs"), target: path.join(outside, "new", "logs") },
  ];

  for (const [index, unsafe] of unsafeRoots.entries()) await t.test(unsafe.name, async (subtest) => {
    const logger = createFileLogger({
      root: unsafe.root,
      home: paths.home,
      sqliteHome: paths.sqliteHome,
      instanceId: `${String(index + 1).repeat(32)}`,
    });
    logger.emit("server_start");
    await logger.close();
    assert.equal(logger.status().healthy, false);
    assert.equal(logger.status().lastErrorCode, "log_root_unsafe");
    assert.equal(await exists(unsafe.root), false, "unsafe root must not be created");
    assert.equal(await exists(unsafe.target), false, "resolved target must not be created");
    assert.deepEqual(await snapshot(fixtureFiles), before);
    subtest.diagnostic(`checked synthetic fixtures: ${fixtureFiles.length}`);
  });
});

test("a lock unlinked between open and fstat retries without dropping the queued record", async (t) => {
  const paths = await makePaths(t);
  await mkdir(paths.root, { mode: 0o700 });
  const lockPath = path.join(paths.root, ".codex-trajectory-viewer.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: "1".repeat(32), token: "2".repeat(32) }), { mode: 0o600 });
  const control = await open(lockPath, "r");
  const info = await control.stat();
  const prototype = Object.getPrototypeOf(control);
  const originalStat = prototype.stat;
  await control.close();
  let released = false;
  t.mock.method(prototype, "stat", async function (...args) {
    const current = await originalStat.apply(this, args);
    if (!released && current.dev === info.dev && current.ino === info.ino) {
      released = true;
      await unlink(lockPath);
      return originalStat.apply(this, args);
    }
    return current;
  });
  const logger = createFileLogger(paths);
  logger.emit("server_start");
  await logger.close();
  assert.equal(released, true, "exercise the unlinked, still-open lock descriptor");
  assert.equal(logger.status().healthy, true);
  assert.equal(logger.status().dropped, 0);
  assert.equal((await recordsAt(paths.root)).length, 1);
});

test("two live file loggers serialize their first concurrent writes without losing or interleaving records", async (t) => {
  const paths = await makePaths(t);
  const clock = () => new Date(2026, 9, 30, 12);
  const first = createFileLogger({ ...paths, instanceId: "88888888888888888888888888888888", clock });
  const second = createFileLogger({ ...paths, instanceId: "99999999999999999999999999999999", clock });
  t.after(() => Promise.all([first.close(), second.close()]));

  for (let i = 0; i < 25; i += 1) {
    first.emit("server_start");
    second.emit("server_shutdown");
  }
  await Promise.all([first.close(), second.close()]);

  assert.equal(first.status().healthy, true, `first logger must stay healthy: ${JSON.stringify(first.status())}`);
  assert.equal(second.status().healthy, true, `second logger must stay healthy: ${JSON.stringify(second.status())}`);
  assert.equal(first.status().lastErrorCode, null);
  assert.equal(second.status().lastErrorCode, null);
  const files = await logFiles(paths.root);
  assert.equal(files.length, 2);
  const records = await recordsAt(paths.root);
  assert.equal(records.length, 50);
  assert.equal(records.filter((record) => record.instance_id === "88888888888888888888888888888888").length, 25);
  assert.equal(records.filter((record) => record.instance_id === "99999999999999999999999999999999").length, 25);
  for (const file of files) assert.equal((await readFile(file, "utf8")).trimEnd().split("\n").length, 25);
  assert.equal(await exists(path.join(paths.root, ".codex-trajectory-viewer.lock")), false, "the final owner must release the lock");
});

test("two Node processes serialize writes to one synthetic file log root", async (t) => {
  const paths = await makePaths(t);
  const moduleUrl = new URL("../server-dist/logger.js", import.meta.url).href;
  const childScript = `
    import { createFileLogger } from ${JSON.stringify(moduleUrl)};
    const [root, home, sqliteHome, instanceId] = process.argv.slice(1);
    const logger = createFileLogger({ root, home, sqliteHome, instanceId, clock: () => new Date(2026, 9, 30, 12) });
    for (let i = 0; i < 25; i += 1) logger.emit("server_start");
    await logger.close();
    const status = logger.status();
    if (!status.healthy || status.dropped !== 0 || status.lastErrorCode !== null) process.exitCode = 1;
  `;
  const runChild = (instanceId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childScript,
      paths.root,
      paths.home,
      paths.sqliteHome,
      instanceId,
    ], {
      cwd: paths.base,
      env: { CODEX_HOME: paths.home, CODEX_SQLITE_HOME: paths.sqliteHome },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`synthetic logger process ${instanceId} exited with code ${code} signal ${signal}: ${stderr}`));
    });
  });

  const firstId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secondId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await Promise.all([runChild(firstId), runChild(secondId)]);

  const files = await logFiles(paths.root);
  const records = await recordsAt(paths.root);
  assert.equal(files.length, 2);
  assert.equal(records.length, 50);
  assert.equal(records.filter((record) => record.instance_id === firstId).length, 25);
  assert.equal(records.filter((record) => record.instance_id === secondId).length, 25);
  for (const file of files) assert.equal((await readFile(file, "utf8")).trimEnd().split("\n").length, 25);
  assert.equal(await exists(path.join(paths.root, ".codex-trajectory-viewer.lock")), false);
});

test("event allowlists drop private values, invalid IDs, debug by default, and prototype event names", async () => {
  const { records, sink } = memorySink();
  const logger = createAppLogger({ sink, instanceId: FIXED_INSTANCE_IDS, clock: () => new Date(2026, 9, 30, 12), stderr: () => undefined });
  const secret = "LOG_PRIVACY_SENTINEL_do_not_write";
  logger.emit("request_cancelled", { route: "sessions_list" });
  logger.emit("http_request_terminal", {
    route: "sessions_detail",
    status: 200,
    bytes: 10,
    duration_ms: 4,
    outcome: "success",
    classification: "normal",
    body: secret,
    query: secret,
    path: secret,
    session_id: secret,
    title: secret,
    url: secret,
    headers: secret,
    raw_error: secret,
    message: secret,
  }, {
    operation_id: validUuid,
    request_id: validUuid,
    client_id: secret,
    tab_id: validUuid,
    event_id: secret,
  });
  logger.emit("browser_refresh", { action: "success", outcome: "success", duration_ms: 3, operation_id: secret }, { operation_id: secret });
  assert.doesNotThrow(() => logger.emit("__proto__", { body: secret }));
  assert.doesNotThrow(() => logger.emit("constructor", { body: secret }));
  await logger.close();

  assert.equal(records.some((record) => record.event === "request_cancelled"), false, "default info threshold filters debug");
  assert.equal(records.some((record) => record.event === "__proto__" || record.event === "constructor"), false);
  const request = records.find((record) => record.event === "http_request_terminal");
  assert.ok(request);
  assert.equal(request.operation_id, validUuid);
  assert.equal(request.request_id, validUuid);
  assert.equal(request.tab_id, validUuid);
  assert.equal("client_id" in request, false);
  assert.equal("event_id" in request, false);
  assert.equal("body" in request, false);
  assert.equal("path" in request, false);
  assert.equal("session_id" in request, false);
  assert.equal("title" in request, false);
  assert.equal(records.some((record) => record.event === "browser_refresh" && "operation_id" in record), false);
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(sink.closeCount, 1);
});

test("bounded queues drop low priority first, report health changes, and recover after sink failures", async () => {
  const entered = deferred();
  const release = deferred();
  const writes = [];
  const { sink } = memorySink(async (record) => {
    writes.push(record.event);
    if (writes.length === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  const logger = createAppLogger({
    sink,
    instanceId: FIXED_INSTANCE_IDS,
    minLevel: "debug",
    maxQueueEvents: 1,
    maxQueueBytes: 4096,
    stderr: () => undefined,
  });
  logger.emit("server_start");
  await entered.promise;
  logger.emit("discovery_complete", { sessions: 4 });
  logger.emit("request_cancelled", { route: "sessions_list" });
  logger.emit("sqlite_source_warning", { database: "state_5.sqlite", state: "degraded", error_code: "sqlite_unavailable" });
  assert.equal(logger.status().queued, 1);
  assert.equal(logger.status().dropped, 2);
  assert.equal(logger.status().healthy, false);
  assert.equal(logger.status().lastErrorCode, "queue_full");
  release.resolve();
  await logger.close();
  assert.deepEqual(writes.slice(0, 2), ["server_start", "sqlite_source_warning"]);
  assert.equal(logger.status().healthy, true, "successful drain restores logger health");

  const byteEntered = deferred();
  const byteRelease = deferred();
  const byteSink = memorySink(async (_record) => {
    byteEntered.resolve();
    await byteRelease.promise;
  });
  const byteLogger = createAppLogger({ sink: byteSink.sink, maxQueueEvents: 100, maxQueueBytes: 512, stderr: () => undefined });
  byteLogger.emit("server_start");
  await byteEntered.promise;
  for (let index = 0; index < 200; index += 1) byteLogger.emit("server_start");
  assert.ok(byteLogger.status().queued < 100, "byte limit bounds queued records before the event-count limit is reached");
  assert.ok(byteLogger.status().dropped > 0);
  assert.equal(byteLogger.status().lastErrorCode, "queue_full");
  byteRelease.resolve();
  await byteLogger.close();

  let failed = false;
  const failedWrites = [];
  const recoveredSink = {
    async write(record, serialized) {
      if (!failed) { failed = true; throw new Error("synthetic sink failure"); }
      failedWrites.push(JSON.parse(serialized));
    },
    async close() {},
  };
  const recoveryLogger = createAppLogger({ sink: recoveredSink, stderr: () => undefined });
  recoveryLogger.emit("server_start");
  await waitFor(() => recoveryLogger.status().lastErrorCode === "log_write_failed", "sink failure did not reach health status");
  assert.equal(recoveryLogger.status().healthy, false);
  recoveryLogger.emit("server_shutdown");
  await waitFor(() => failedWrites.some((record) => record.event === "logger_drop_summary"), "successful writes did not emit a drop summary");
  await recoveryLogger.close();
  assert.ok(failedWrites.some((record) => record.event === "server_shutdown"));
  assert.ok(failedWrites.some((record) => record.event === "logger_drop_summary"));
  assert.equal(recoveryLogger.status().healthy, true);
});

test("close stops new records immediately and returns after a slow sink settles", async () => {
  const entered = deferred();
  const release = deferred();
  const writes = [];
  let closeCount = 0;
  const sink = {
    async write(record) {
      writes.push(record.event);
      if (writes.length === 1) {
        entered.resolve();
        await release.promise;
      }
    },
    async close() { closeCount += 1; },
  };
  const logger = createAppLogger({ sink, closeTimeoutMs: 500, stderr: () => undefined });
  logger.emit("server_start");
  await entered.promise;
  const closing = logger.close(500);
  logger.emit("server_shutdown");
  release.resolve();
  await closing;

  assert.deepEqual(writes, ["server_start"], "records emitted after close begins cannot start a new drain");
  assert.equal(closeCount, 1);
  assert.equal(logger.status().queued, 0);
});
