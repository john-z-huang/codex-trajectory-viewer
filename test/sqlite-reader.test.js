import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSessionSupplement, readSessionSupplementSnapshot, searchSessionHistory, SupplementRevisionError } from "../server-dist/sqlite-reader.js";

function createDatabase(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

test("SQLite 全历史字面搜索跨页、回绕、区分大小写并沿用只读快照关联", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-history-search-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "thread_history_1.sqlite");
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, summary TEXT); CREATE TABLE thread_items(turn_id TEXT, rollout_ordinal INTEGER, item_json TEXT);");
  const needle = 'Needle %_ "quoted"';
  for (let index = 0; index < 60; index += 1) {
    writer.prepare("INSERT INTO thread_turns VALUES ('target', ?, 'turn-only-token')").run(`turn-${index}`);
    writer.prepare("INSERT INTO thread_items VALUES (?, ?, ?)").run(`turn-${index}`, index, index === 51 || index === 55 ? "x".repeat(20_000) + needle : `plain-${index}`);
  }
  writer.exec("INSERT INTO thread_turns VALUES ('other', 'foreign-turn', 'foreign'); INSERT INTO thread_items VALUES ('foreign-turn', -1, 'foreign-only-token');");
  const session = { sessionId: "target" };
  const { supplementRevision } = await readSessionSupplementSnapshot(home, session);
  const search = (query, afterIndex = 0, revision = supplementRevision) => searchSessionHistory(home, session, revision, query, afterIndex);
  assert.deepEqual(await search(needle), { rowIndex: 52, page: 2, totalRows: 60 });
  assert.deepEqual(await search(needle, 52), { rowIndex: 56, page: 2, totalRows: 60 });
  assert.deepEqual(await search(needle, 56), { rowIndex: 52, page: 2, totalRows: 60 });
  for (const query of [needle.toLowerCase(), "foreign-only-token", "turn-only-token", "absent"]) {
    assert.deepEqual(await search(query), { rowIndex: null, page: null, totalRows: 60 });
  }
  await assert.rejects(search(needle, 0, "forged"), SupplementRevisionError);
  writer.prepare("INSERT INTO thread_items VALUES ('turn-0', -1, ?)").run(needle);
  const before = await readFile(file);
  const walBefore = await readFile(`${file}-wal`);
  assert.deepEqual(await search(needle), { rowIndex: 52, page: 2, totalRows: 60 }, "appends with low ordinals stay outside the original search range");
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(`${file}-wal`), walBefore);
  writer.exec("UPDATE thread_items SET item_json = 'rewritten' WHERE rollout_ordinal = 51;");
  await assert.rejects(search(needle), SupplementRevisionError);
});

test("SQLite 搜索对缺库及缺历史项目表返回可读错误", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-history-search-missing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const session = { sessionId: "target" };
  const missing = await readSessionSupplementSnapshot(home, session);
  await assert.rejects(searchSessionHistory(home, session, missing.supplementRevision, "query"), /database not present/);
  createDatabase(path.join(home, "thread_history_1.sqlite"), "CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT); INSERT INTO thread_turns VALUES ('target', 'turn');");
  const partial = await readSessionSupplementSnapshot(home, session);
  await assert.rejects(searchSessionHistory(home, session, partial.supplementRevision, "query"), /table not present/);
});

test("会话说明全量读取所有关联行与长字段，历史仍按页读取且不修改合成数据库", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-full-description-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const description = `${"完整说明".repeat(4_000)}说明末尾`;
  const files = ["state_5.sqlite", "goals_1.sqlite", "thread_history_1.sqlite"].map((name) => path.join(home, name));
  for (const [index, file] of files.entries()) {
    const db = new DatabaseSync(file);
    try {
      const table = ["threads", "thread_goals", "thread_items"][index];
      db.exec(`CREATE TABLE ${table}(thread_id TEXT, extra_field TEXT, binary_value BLOB)`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`);
      db.exec("BEGIN");
      for (let row = 0; row < 505; row += 1) insert.run("target", row === 504 ? description : `row-${row}`, new Uint8Array([0, 255]));
      insert.run("other", "不能读取其他会话说明", new Uint8Array());
      db.exec("COMMIT");
    } finally { db.close(); }
  }
  const before = await Promise.all(files.map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex")));
  const session = { id: "target", sessionId: "target" };
  const legacy = await readSessionSupplement(home, session, { historyPage: 2 });
  const snapshot = await readSessionSupplementSnapshot(home, session, { historyPage: 2 });
  for (const sources of [legacy, snapshot.supplement]) {
    for (const source of sources.filter((source) => source.database !== "thread_history_1.sqlite")) {
      const table = source.tables[0];
      assert.equal(table.rows.length, 505);
      assert.equal(table.rows.at(-1).extra_field, description);
      assert.deepEqual(table.rows.at(-1).binary_value, [0, 255]);
      assert.equal(table.pagination, undefined);
      assert.ok(table.rows.every((row) => row.thread_id === "target"));
    }
    const items = sources.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_items");
    assert.equal(items.rows.length, 50);
    assert.equal(items.rows[0].extra_field, "row-50");
    assert.equal(items.pagination.totalRows, 505);
    assert.equal(items.pagination.page, 2);
  }
  for (const sources of [
    await readSessionSupplement(home, session, { historyPage: 11 }),
    (await readSessionSupplementSnapshot(home, session, { historyPage: 11 })).supplement,
  ]) {
    const items = sources.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_items");
    assert.equal(items.rows.at(-1).extra_field, description, "history fields also retain text beyond 12000 characters");
    assert.deepEqual(items.rows.at(-1).binary_value, [0, 255]);
  }
  assert.deepEqual(await Promise.all(files.map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex"))), before);
});

test("SQLite 快照按原始行边界分页，关联 items 不依赖当前 turns 页且不读入低 ordinal 新行", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-snapshot-relations-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "thread_history_1.sqlite");
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); CREATE TABLE thread_items(turn_id TEXT, rollout_ordinal INTEGER, content TEXT);");
  for (let i = 0; i < 53; i++) {
    writer.prepare("INSERT INTO thread_turns VALUES ('target', ?, ?)").run(`turn-${i}`, i);
    writer.prepare("INSERT INTO thread_items VALUES (?, ?, ?)").run(`turn-${i}`, i, `old-${i}`);
  }
  const initial = await readSessionSupplementSnapshot(home, { sessionId: "target" });
  writer.exec("INSERT INTO thread_turns VALUES ('target', 'new-turn', -1), ('other', 'other-turn', 1); INSERT INTO thread_items VALUES ('turn-0', -1, 'new-low-ordinal'), ('new-turn', -2, 'new-turn-item'), ('other-turn', 0, 'unrelated');");
  const before = await readFile(file);
  const walBefore = await readFile(`${file}-wal`);
  const old = await readSessionSupplementSnapshot(home, { sessionId: "target" }, { historyPage: 2, revision: initial.supplementRevision });
  assert.equal(old.supplementRevision, initial.supplementRevision);
  const tables = old.supplement[0].tables;
  for (const table of tables) assert.deepEqual(table.pagination, { page: 2, pageSize: 50, totalRows: 53, hasMore: false });
  assert.deepEqual(tables.find((table) => table.table === "thread_items").rows.map((row) => row.content), ["old-50", "old-51", "old-52"]);
  const fresh = await readSessionSupplementSnapshot(home, { sessionId: "target" });
  assert.equal(fresh.supplement[1].tables.find((table) => table.table === "thread_items").pagination.totalRows, 55);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(`${file}-wal`), walBefore);
});

test("SQLite 快照校验完整历史值、删除和 schema，拒绝伪造或跨会话版本", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-snapshot-validation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "thread_history_1.sqlite");
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT); CREATE TABLE thread_items(thread_id TEXT, content TEXT); INSERT INTO thread_turns VALUES ('target', 'turn');");
  writer.prepare("INSERT INTO thread_items VALUES ('target', ?)").run("x".repeat(13_000) + "a");
  const capture = () => readSessionSupplementSnapshot(home, { sessionId: "target" });
  const read = (revision, sessionId = "target") => readSessionSupplementSnapshot(home, { sessionId }, { historyPage: 2, revision });
  const initial = await capture();
  await assert.rejects(read(initial.supplementRevision + "x"), SupplementRevisionError);
  await assert.rejects(read("x".repeat(8_193)), SupplementRevisionError);
  await assert.rejects(read(initial.supplementRevision, "other"), SupplementRevisionError);
  writer.prepare("UPDATE thread_items SET content = ?").run("x".repeat(13_000) + "b");
  await assert.rejects(read(initial.supplementRevision), SupplementRevisionError, "hash the complete value beyond the display truncation");
  const beforeDelete = await capture();
  writer.exec("DELETE FROM thread_items;");
  await assert.rejects(read(beforeDelete.supplementRevision), SupplementRevisionError);
  const beforeSchema = await capture();
  writer.exec("ALTER TABLE thread_turns ADD COLUMN extra TEXT;");
  await assert.rejects(read(beforeSchema.supplementRevision), SupplementRevisionError);
});

test("SQLite 快照保留缺库/缺表状态，只有新窗口读取后来出现的来源", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-snapshot-missing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const session = { sessionId: "target" };
  const missing = await readSessionSupplementSnapshot(home, session);
  createDatabase(path.join(home, "thread_history_1.sqlite"), "CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT); INSERT INTO thread_turns VALUES ('target', 'turn');");
  const old = await readSessionSupplementSnapshot(home, session, { revision: missing.supplementRevision });
  assert.equal(old.supplement[0].available, false);
  const beforeTable = await readSessionSupplementSnapshot(home, session);
  createDatabase(path.join(home, "thread_history_1.sqlite"), "CREATE TABLE thread_items(thread_id TEXT, content TEXT); INSERT INTO thread_items VALUES ('target', 'new');");
  const oldTable = await readSessionSupplementSnapshot(home, session, { revision: beforeTable.supplementRevision });
  assert.equal(oldTable.supplement[0].tables.find((table) => table.table === "thread_items").available, false);
  assert.equal((await readSessionSupplementSnapshot(home, session)).supplement[1].tables.find((table) => table.table === "thread_items").rows[0].content, "new");
});

test("SQLite 数据库替换后即使内容相同也拒绝旧快照", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-snapshot-replaced-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "thread_history_1.sqlite");
  createDatabase(file, "CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT); INSERT INTO thread_turns VALUES ('target', 'turn');");
  const initial = await readSessionSupplementSnapshot(home, { sessionId: "target" });
  const replacement = path.join(home, "replacement.sqlite");
  await writeFile(replacement, await readFile(file));
  await rename(replacement, file);
  await assert.rejects(readSessionSupplementSnapshot(home, { sessionId: "target" }, { revision: initial.supplementRevision }), SupplementRevisionError);
});

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
