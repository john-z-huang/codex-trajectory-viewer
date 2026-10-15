import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSessionSupplement } from "../server/sqlite-reader.js";

function createDatabase(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

test("只读关联支持三种 schema，容错缺表并忽略其他数据库", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const threadId = "11111111-1111-4111-8111-111111111111";
  const statePath = path.join(home, "state_5.sqlite");
  createDatabase(statePath, `CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES ('${threadId}', '合成会话');`);
  createDatabase(path.join(home, "thread_history_1.sqlite"), `
    CREATE TABLE thread_turns(id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
    CREATE TABLE thread_items(id TEXT PRIMARY KEY, turn_id TEXT, item_type TEXT, content TEXT);
    INSERT INTO thread_turns VALUES ('turn-1', '${threadId}', 'completed');
    INSERT INTO thread_items VALUES ('item-1', 'turn-1', 'message', '合成项');
  `);
  createDatabase(path.join(home, "goals_1.sqlite"), `CREATE TABLE thread_goals(id TEXT, thread_id TEXT, goal TEXT); INSERT INTO thread_goals VALUES ('goal-1', '${threadId}', '合成目标');`);
  createDatabase(path.join(home, "logs_1.sqlite"), "CREATE TABLE logs(message TEXT); INSERT INTO logs VALUES ('排除库');");
  const databasePaths = [statePath, path.join(home, "thread_history_1.sqlite"), path.join(home, "goals_1.sqlite"), path.join(home, "logs_1.sqlite")];
  const beforeHashes = new Map(await Promise.all(databasePaths.map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const sources = await readSessionSupplement(home, { sessionId: threadId });
  assert.deepEqual(sources.map((source) => source.database), ["state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite"]);
  assert.equal(sources[0].tables.find((table) => table.table === "threads").rows[0].title, "合成会话");
  assert.equal(sources[1].tables.find((table) => table.table === "thread_items").rows[0].content, "合成项");
  assert.equal(sources[2].tables.find((table) => table.table === "thread_goals").rows[0].goal, "合成目标");
  for (const [file, hash] of beforeHashes) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash, `${path.basename(file)} must remain unchanged`);
});

test("SQLite 缺失、损坏、schema 漂移与越界符号链接均作为来源状态返回", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-errors-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-outside-"));
  t.after(async () => { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(path.join(home, "thread_history_1.sqlite"), "not sqlite");
  createDatabase(path.join(home, "goals_1.sqlite"), "CREATE TABLE unrelated(value TEXT);");
  createDatabase(path.join(outside, "state_5.sqlite"), "CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES ('secret');");
  await symlink(path.join(outside, "state_5.sqlite"), path.join(home, "state_5.sqlite"));
  const sources = await readSessionSupplement(home, { sessionId: "secret" });
  assert.equal(sources[0].available, false);
  assert.match(sources[0].error, /escapes CODEX_SQLITE_HOME/);
  assert.equal(sources[1].available, false);
  assert.equal(sources[2].available, true);
  assert.equal(sources[2].tables.length, 1);
  assert.equal(sources[2].tables[0].reason, "table not present in this schema");
});

test("thread history 使用标准 thread_id / turn_id，缺少可选列仍可关联 items", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-standard-columns-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const threadId = "standard-thread";
  createDatabase(path.join(home, "thread_history_1.sqlite"), `
    CREATE TABLE thread_turns(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL);
    CREATE TABLE thread_items(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_type TEXT NOT NULL);
    INSERT INTO thread_turns VALUES ('${threadId}', 'turn-standard');
    INSERT INTO thread_items VALUES ('${threadId}', 'turn-standard', 'assistant_message');
  `);
  const sources = await readSessionSupplement(home, { sessionId: threadId });
  const history = sources.find((source) => source.database === "thread_history_1.sqlite");
  assert.deepEqual(history.tables.find((table) => table.table === "thread_turns").rows, [{ thread_id: threadId, turn_id: "turn-standard" }]);
  assert.deepEqual(history.tables.find((table) => table.table === "thread_items").rows, [{ thread_id: threadId, turn_id: "turn-standard", item_type: "assistant_message" }]);
});

test("thread history 按 50 条分页读取且不改动 SQLite 文件", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-history-pages-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const threadId = "paged-thread";
  const values = Array.from({ length: 53 }, (_, index) => `('${threadId}', 'turn-${index}', ${index})`).join(",");
  const dbPath = path.join(home, "thread_history_1.sqlite");
  createDatabase(dbPath, `
    CREATE TABLE thread_turns(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL);
    CREATE TABLE thread_items(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL);
    INSERT INTO thread_turns VALUES ${values};
    INSERT INTO thread_items VALUES ${values};
  `);
  const before = createHash("sha256").update(await readFile(dbPath)).digest("hex");
  const readPage = async (historyPage) => {
    const sources = await readSessionSupplement(home, { sessionId: threadId }, { historyPage });
    return sources.find((source) => source.database === "thread_history_1.sqlite").tables;
  };
  const firstPage = await readPage(1);
  const secondPage = await readPage(2);
  for (const tableName of ["thread_turns", "thread_items"]) {
    const first = firstPage.find((table) => table.table === tableName);
    const second = secondPage.find((table) => table.table === tableName);
    assert.equal(first.rows.length, 50);
    assert.deepEqual(first.pagination, { page: 1, pageSize: 50, totalRows: 53, hasMore: true });
    assert.equal(second.rows.length, 3);
    assert.deepEqual(second.pagination, { page: 2, pageSize: 50, totalRows: 53, hasMore: false });
    assert.deepEqual(second.rows.map((row) => row.rollout_ordinal), [50, 51, 52]);
  }
  assert.equal(createHash("sha256").update(await readFile(dbPath)).digest("hex"), before);
});
