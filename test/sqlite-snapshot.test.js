import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { ALLOWED_SQLITE_DATABASES, withSQLiteSnapshot } from "../server-dist/sqlite-snapshot.js";
import { readThreadSummaries } from "../server-dist/sqlite-reader.js";

const SNAPSHOT_NAMESPACE = "codex-trajectory-viewer-sqlite-snapshots";

async function makeSandbox(t) {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "ctv-sqlite-snapshot-test-"));
  await chmod(base, 0o700);
  const sandbox = {
    base,
    tempRoot: base,
    home: path.join(base, "codex-home"),
    sqliteHome: path.join(base, "sqlite-home"),
    logRoot: path.join(base, "logs"),
    writers: [],
  };
  await Promise.all([sandbox.home, sandbox.sqliteHome, sandbox.logRoot].map((directory) => mkdir(directory, { mode: 0o700 })));
  t.after(async () => {
    for (const database of sandbox.writers) {
      try { database.close(); } catch { /* The test may close its writer before cleanup. */ }
    }
    await rm(base, { recursive: true, force: true });
  });
  return sandbox;
}

function snapshotOptions(sandbox, overrides = {}) {
  return {
    codexHome: sandbox.home,
    sqliteHome: sandbox.sqliteHome,
    tempRoot: sandbox.tempRoot,
    defaultLogRoot: sandbox.logRoot,
    ...overrides,
  };
}

function createDatabase(filename, values = ["synthetic row"]) {
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE sample (value TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO sample(value) VALUES (?)");
  for (const value of values) insert.run(value);
  return database;
}

function openWalWriter(filename) {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA wal_autocheckpoint = 0");
  return database;
}

function valuesFrom(database) {
  return database.prepare("SELECT value FROM sample ORDER BY rowid").all().map((row) => row.value);
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function fileHash(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function hashIfPresent(filename) {
  if (!await exists(filename)) return null;
  return fileHash(filename);
}

async function assertNoSnapshotDirectories(sandbox) {
  const namespace = path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE);
  if (!await exists(namespace)) return;
  const entries = await readdir(namespace);
  assert.equal(entries.some((entry) => entry.startsWith("snapshot-")), false, "temporary SQLite copies must be removed");
}

test("the snapshot helper only accepts the three configured SQLite databases", async (t) => {
  const sandbox = await makeSandbox(t);
  assert.deepEqual(ALLOWED_SQLITE_DATABASES, ["state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite"]);

  await assert.rejects(
    withSQLiteSnapshot("unlisted.sqlite", snapshotOptions(sandbox), () => "unexpected"),
    (error) => error?.code === "SQLITE_CANTOPEN",
  );
  assert.equal(await exists(path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE)), false, "an unlisted name must fail before creating the namespace");
});

test("copies an allowlisted main database and active WAL privately, reads only the copy, and preserves source bytes", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "state_5.sqlite");
  const setup = createDatabase(sourcePath, ["first", "second"]);
  setup.close();
  const activeWriter = openWalWriter(sourcePath);
  activeWriter.prepare("INSERT INTO sample(value) VALUES (?)").run("uncheckpointed");
  sandbox.writers.push(activeWriter);

  const sourceSidecars = [`${sourcePath}-wal`, `${sourcePath}-shm`];
  assert.equal(await exists(sourceSidecars[0]), true, "the fixture must have an active WAL");
  assert.equal(await exists(sourceSidecars[1]), true, "the fixture must have an active SHM");
  const originalHashes = await Promise.all([sourcePath, ...sourceSidecars].map(fileHash));
  let snapshotDirectory;
  const result = await withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), async (copyPath, identity) => {
    snapshotDirectory = path.dirname(copyPath);
    assert.equal((await lstat(snapshotDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(copyPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(`${copyPath}-wal`)).mode & 0o777, 0o600);
    assert.equal(await exists(`${copyPath}-shm`), false, "source SHM must not be copied into the snapshot");
    assert.match(identity.token, /^[a-f0-9]{64}$/);
    assert.equal(identity.token.includes(sourcePath), false, "revision identity must not expose a source path");

    const reader = new DatabaseSync(copyPath, { readOnly: true });
    try {
      return valuesFrom(reader);
    } finally {
      reader.close();
    }
  });

  assert.deepEqual(result.value, ["first", "second", "uncheckpointed"]);
  assert.equal(result.identity.token.length, 64);
  assert.deepEqual(await Promise.all([sourcePath, ...sourceSidecars].map(fileHash)), originalHashes);
  assert.equal(await exists(snapshotDirectory), false, "the private snapshot directory must be removed after success");
  assert.equal((await lstat(path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE))).mode & 0o777, 0o700);
});

test("omits an absent WAL and removes the private copy when the reader fails", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "thread_history_1.sqlite");
  const source = createDatabase(sourcePath, ["committed"]);
  source.close();
  assert.equal(await exists(`${sourcePath}-wal`), false);

  let snapshotDirectory;
  const value = await withSQLiteSnapshot("thread_history_1.sqlite", snapshotOptions(sandbox), async (copyPath) => {
    snapshotDirectory = path.dirname(copyPath);
    assert.equal(await exists(`${copyPath}-wal`), false);
    const reader = new DatabaseSync(copyPath, { readOnly: true });
    try { return valuesFrom(reader); }
    finally { reader.close(); }
  });
  assert.deepEqual(value.value, ["committed"]);
  assert.equal(await exists(snapshotDirectory), false);

  let failedSnapshotDirectory;
  await assert.rejects(
    withSQLiteSnapshot("thread_history_1.sqlite", snapshotOptions(sandbox), async (copyPath) => {
      failedSnapshotDirectory = path.dirname(copyPath);
      throw new Error("synthetic reader failure");
    }),
    /synthetic reader failure/,
  );
  assert.equal(await exists(failedSnapshotDirectory), false, "finally cleanup must also run after reader errors");
});

test("retries when the source database identity changes during a read", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "goals_1.sqlite");
  const oldDatabase = createDatabase(sourcePath, ["before replacement"]);
  oldDatabase.close();
  const oldPath = path.join(sandbox.sqliteHome, "previous-synthetic.sqlite");
  let attempts = 0;
  let firstIdentity;

  const result = await withSQLiteSnapshot("goals_1.sqlite", snapshotOptions(sandbox, { maxAttempts: 3 }), async (copyPath, identity) => {
    attempts += 1;
    const reader = new DatabaseSync(copyPath, { readOnly: true });
    let values;
    try { values = valuesFrom(reader); }
    finally { reader.close(); }
    if (attempts === 1) {
      firstIdentity = identity.token;
      await rename(sourcePath, oldPath);
      const replacement = createDatabase(sourcePath, ["after replacement"]);
      replacement.close();
    }
    return { values, token: identity.token };
  });

  assert.equal(attempts, 2, "an identity drift must discard and retry the first snapshot");
  assert.deepEqual(result.value.values, ["after replacement"]);
  assert.notEqual(result.value.token, firstIdentity);
  assert.equal(result.identity.token, result.value.token);
  await assertNoSnapshotDirectories(sandbox);
});

test("thread summaries discard a stale attempt Map and avoid snapshots for empty session lists", async (t) => {
  const sandbox = await makeSandbox(t);
  const loggerStates = [];
  const logger = { sourceState: (...state) => loggerStates.push(state) };

  const empty = await readThreadSummaries(sandbox.sqliteHome, [], logger, undefined, snapshotOptions(sandbox));
  assert.equal(empty.size, 0);
  assert.deepEqual(loggerStates, []);
  assert.equal(await exists(path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE)), false, "empty sessions must skip the full database copy");

  const sourcePath = path.join(sandbox.sqliteHome, "state_5.sqlite");
  const writer = new DatabaseSync(sourcePath);
  writer.exec("CREATE TABLE threads(id TEXT NOT NULL, title TEXT)");
  writer.prepare("INSERT INTO threads(id, title) VALUES (?, ?)").run("thread-1", "stale title");
  writer.close();
  let attempts = 0;
  let deleted = false;
  const mutatingLogger = {
    sourceState(database, state) {
      if (database !== "state_5.sqlite" || state !== "available") return;
      attempts += 1;
      if (deleted) return;
      deleted = true;
      const sourceWriter = new DatabaseSync(sourcePath);
      try { sourceWriter.prepare("DELETE FROM threads WHERE id = ?").run("thread-1"); }
      finally { sourceWriter.close(); }
    },
  };

  const summaries = await readThreadSummaries(
    sandbox.sqliteHome,
    [{ sessionId: "thread-1" }],
    mutatingLogger,
    undefined,
    snapshotOptions(sandbox),
  );
  assert.equal(deleted, true);
  assert.equal(attempts, 2, "source drift after the first callback must force a retry");
  assert.equal(summaries.has("thread-1"), false, "rows from the discarded first snapshot must not survive the retry");
  await assertNoSnapshotDirectories(sandbox);
});

test("retries when a WAL appears or disappears while snapshots are being read", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "state_5.sqlite");
  const initial = createDatabase(sourcePath, ["main database"]);
  initial.close();
  let writer;
  sandbox.writers.push({ close() { try { writer?.close(); } catch { /* already closed */ } } });

  let appearanceAttempts = 0;
  const appeared = await withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), async (copyPath) => {
    appearanceAttempts += 1;
    assert.equal(await exists(`${copyPath}-wal`), appearanceAttempts > 1);
    if (appearanceAttempts === 1) {
      writer = openWalWriter(sourcePath);
      writer.prepare("INSERT INTO sample(value) VALUES (?)").run("new WAL row");
      return [];
    }
    const reader = new DatabaseSync(copyPath, { readOnly: true });
    try { return valuesFrom(reader); }
    finally { reader.close(); }
  });
  assert.equal(appearanceAttempts, 2);
  assert.deepEqual(appeared.value, ["main database", "new WAL row"]);
  writer.close();
  writer = undefined;

  const walSourcePath = path.join(sandbox.sqliteHome, "thread_history_1.sqlite");
  const walDatabase = createDatabase(walSourcePath, ["wal row"]);
  walDatabase.close();
  writer = openWalWriter(walSourcePath);
  writer.prepare("INSERT INTO sample(value) VALUES (?)").run("uncheckpointed row");
  let disappearanceAttempts = 0;
  const disappeared = await withSQLiteSnapshot("thread_history_1.sqlite", snapshotOptions(sandbox), async (copyPath) => {
    disappearanceAttempts += 1;
    assert.equal(await exists(`${copyPath}-wal`), disappearanceAttempts === 1);
    if (disappearanceAttempts === 1) {
      const reader = new DatabaseSync(copyPath, { readOnly: true });
      try { assert.deepEqual(valuesFrom(reader), ["wal row", "uncheckpointed row"]); }
      finally { reader.close(); }
      writer.close();
      writer = undefined;
      return [];
    }
    const reader = new DatabaseSync(copyPath, { readOnly: true });
    try { return valuesFrom(reader); }
    finally { reader.close(); }
  });
  assert.equal(disappearanceAttempts, 2);
  assert.deepEqual(disappeared.value, ["wal row", "uncheckpointed row"]);
  await assertNoSnapshotDirectories(sandbox);
});

test("rejects a hot rollback journal without copying it", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "state_5.sqlite");
  const writer = createDatabase(sourcePath);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("INSERT INTO sample(value) VALUES (?)").run("uncommitted");
  sandbox.writers.push({ close() { try { writer.exec("ROLLBACK"); } catch { /* already closed or rolled back */ } try { writer.close(); } catch { /* cleanup */ } } });
  const journalPath = `${sourcePath}-journal`;
  assert.equal(await exists(journalPath), true, "the open rollback transaction must have a journal");
  assert.ok((await lstat(journalPath)).size > 0, "the rollback journal must be hot");

  await assert.rejects(
    withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), () => "unexpected"),
    (error) => error?.code === "SQLITE_BUSY",
  );
  const sourceStates = [];
  const summaries = await readThreadSummaries(
    sandbox.sqliteHome,
    [{ sessionId: "synthetic-thread" }],
    { sourceState: (...state) => sourceStates.push(state) },
    undefined,
    snapshotOptions(sandbox),
  );
  assert.equal(summaries.size, 0);
  assert.deepEqual(sourceStates, [["state_5.sqlite", "degraded", "sqlite_unavailable"]]);
  await assertNoSnapshotDirectories(sandbox);
});

test("classifies a SQLite source symlink failure as unavailable", async (t) => {
  const sandbox = await makeSandbox(t);
  const outsidePath = path.join(sandbox.base, "outside-state.sqlite");
  const outside = createDatabase(outsidePath, ["must not be read"]);
  outside.close();
  const sourcePath = path.join(sandbox.sqliteHome, "state_5.sqlite");
  await symlink(outsidePath, sourcePath);
  const sourceStates = [];

  const summaries = await readThreadSummaries(
    sandbox.sqliteHome,
    [{ sessionId: "synthetic-thread" }],
    { sourceState: (...state) => sourceStates.push(state) },
    undefined,
    snapshotOptions(sandbox),
  );
  assert.equal(summaries.size, 0);
  assert.deepEqual(sourceStates, [["state_5.sqlite", "degraded", "sqlite_unavailable"]]);
});

test("rejects a snapshot namespace symlink before touching its target", async (t) => {
  const sandbox = await makeSandbox(t);
  const namespace = path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE);
  const target = path.join(sandbox.base, "symlink-target");
  await mkdir(target);
  await symlink(target, namespace, "dir");

  await assert.rejects(
    withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), () => "unexpected"),
    (error) => error?.code === "EACCES",
  );
  assert.equal((await lstat(namespace)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(target), []);
});

test("rejects effective homes, environment aliases, and log roots overlapping the namespace before mkdir", async (t) => {
  const sandbox = await makeSandbox(t);
  const namespace = path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE);
  const alias = path.join(sandbox.base, "temp-parent-alias");
  await symlink(sandbox.tempRoot, alias, "dir");

  const protectedCases = [
    ["effective CODEX_HOME", { codexHome: path.join(namespace, "codex-home") }],
    ["effective CODEX_SQLITE_HOME", { sqliteHome: path.join(namespace, "sqlite-home") }],
    ["CODEX_HOME symlink alias", { codexHome: alias }],
    ["CODEX_SQLITE_HOME symlink alias", { sqliteHome: alias }],
    ["log-root symlink alias", { defaultLogRoot: alias }],
  ];
  for (const [label, overrides] of protectedCases) {
    await assert.rejects(
      withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox, overrides), () => "unexpected"),
      (error) => error?.code === "EACCES",
      label,
    );
    assert.equal(await exists(namespace), false, `${label} must be rejected before namespace mkdir`);
  }

  const restoreEnvironment = (name, prior) => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  };
  for (const name of ["CODEX_HOME", "CODEX_SQLITE_HOME"]) {
    const prior = process.env[name];
    process.env[name] = alias;
    try {
      await assert.rejects(
        withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), () => "unexpected"),
        (error) => error?.code === "EACCES",
        `${name} environment alias`,
      );
      assert.equal(await exists(namespace), false, `${name} must be rejected before namespace mkdir`);
    } finally {
      restoreEnvironment(name, prior);
    }
  }
});

test("allows ordinary protected sibling directories under the temporary parent", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "goals_1.sqlite");
  const writer = createDatabase(sourcePath, ["sibling paths are allowed"]);
  writer.close();
  const sibling = path.join(sandbox.base, "unrelated-sibling.txt");
  await writeFile(sibling, "preserve this sibling", { mode: 0o600 });
  const before = await fileHash(sibling);

  const result = await withSQLiteSnapshot("goals_1.sqlite", snapshotOptions(sandbox), async (copyPath) => {
    const reader = new DatabaseSync(copyPath, { readOnly: true });
    try { return valuesFrom(reader); }
    finally { reader.close(); }
  });
  assert.deepEqual(result.value, ["sibling paths are allowed"]);
  assert.equal(await fileHash(sibling), before);
  await assertNoSnapshotDirectories(sandbox);
});

test("bounds retries and rejects a source that keeps changing", async (t) => {
  const sandbox = await makeSandbox(t);
  const sourcePath = path.join(sandbox.sqliteHome, "goals_1.sqlite");
  const source = createDatabase(sourcePath);
  source.close();
  let attempts = 0;
  const initialSeconds = Date.now() / 1000;

  await assert.rejects(
    withSQLiteSnapshot("goals_1.sqlite", snapshotOptions(sandbox, { maxAttempts: 2 }), async () => {
      attempts += 1;
      const changedTime = new Date((initialSeconds + attempts * 2) * 1000);
      await utimes(sourcePath, changedTime, changedTime);
      return null;
    }),
    (error) => error?.code === "SQLITE_BUSY",
  );
  assert.equal(attempts, 2, "the helper must stop at its configured retry limit");
  await assertNoSnapshotDirectories(sandbox);
});

test("caps active snapshots and bounded waiters, rejects overflow, and cleans every accepted copy", async (t) => {
  const sandbox = await makeSandbox(t);
  const source = createDatabase(path.join(sandbox.sqliteHome, "state_5.sqlite"));
  source.close();
  const namespace = path.join(sandbox.tempRoot, SNAPSHOT_NAMESPACE);
  let activeReaders = 0;
  let maximumActiveReaders = 0;
  let maximumSnapshotDirectories = 0;
  let enteredFirstPair;
  const firstPairEntered = new Promise((resolve) => { enteredFirstPair = resolve; });
  let releaseReaders;
  const readerGate = new Promise((resolve) => { releaseReaders = resolve; });

  const read = async () => {
    activeReaders += 1;
    maximumActiveReaders = Math.max(maximumActiveReaders, activeReaders);
    const directories = await readdir(namespace);
    maximumSnapshotDirectories = Math.max(maximumSnapshotDirectories, directories.filter((entry) => entry.startsWith("snapshot-")).length);
    if (activeReaders === 2) enteredFirstPair();
    await readerGate;
    activeReaders -= 1;
    return "read";
  };
  const jobs = Array.from({ length: 10 }, () => withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), read));
  const overflow = withSQLiteSnapshot("state_5.sqlite", snapshotOptions(sandbox), read)
    .then(() => null, (error) => error);

  await firstPairEntered;
  assert.equal(maximumActiveReaders, 2);
  assert.equal((await overflow)?.code, "SQLITE_BUSY", "the ninth waiter must be rejected without a copy");
  releaseReaders();
  const accepted = await Promise.all(jobs.slice(0, 10));

  assert.deepEqual(accepted.map((result) => result.value), Array(10).fill("read"));
  assert.equal(maximumActiveReaders, 2);
  assert.ok(maximumSnapshotDirectories <= 2, "no more than two private copies may exist at once");
  await assertNoSnapshotDirectories(sandbox);
});
