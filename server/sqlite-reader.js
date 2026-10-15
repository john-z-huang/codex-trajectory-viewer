import { DatabaseSync } from "node:sqlite";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const DATABASES = [
  { filename: "state_5.sqlite", tables: ["threads"] },
  { filename: "thread_history_1.sqlite", tables: ["thread_turns", "thread_items"] },
  { filename: "goals_1.sqlite", tables: ["thread_goals"] },
];
const THREAD_KEYS = ["thread_id", "threadId", "thread_id_str", "thread_uuid"];
const ID_KEYS = ["id", "thread_id", "threadId", "thread_id_str", "thread_uuid"];

function jsonSafe(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? `[binary data: ${value.byteLength} bytes]` : typeof value === "string" && value.length > 12_000 ? `${value.slice(0, 12_000)}… [truncated]` : value,
  ]));
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function readDatabase(dbPath, tableNames, wantedIds, historyPage = 1) {
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    const existingTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const tables = [];
    const turnIds = new Set();
    for (const table of tableNames) {
      if (!existingTables.has(table)) {
        tables.push({ table, available: false, rows: [], reason: "table not present in this schema" });
        continue;
      }
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
      if (!columns.length) continue;
      const threadColumn = columns.find((column) => THREAD_KEYS.includes(column)) ?? (table === "threads" ? columns.find((column) => column === "id") : undefined);
      const idColumn = table === "thread_turns" ? columns.find((column) => ["turn_id", "id"].includes(column)) : columns.find((column) => ID_KEYS.includes(column));
      const parentColumn = table === "thread_items" ? columns.find((column) => ["turn_id", "thread_turn_id"].includes(column)) : null;
      const clauses = [];
      const values = [];
      if (threadColumn && wantedIds.length) {
        clauses.push(`${quoteIdentifier(threadColumn)} IN (${wantedIds.map(() => "?").join(",")})`);
        values.push(...wantedIds);
      }
      if (!threadColumn && parentColumn && turnIds.size) {
        const ids = [...turnIds];
        clauses.push(`${quoteIdentifier(parentColumn)} IN (${ids.map(() => "?").join(",")})`);
        values.push(...ids);
      }
      if (!clauses.length) {
        tables.push({ table, available: true, rows: [], reason: "schema has no supported session relation column" });
        continue;
      }
      const paginated = table === "thread_turns" || table === "thread_items";
      const pageSize = paginated ? 50 : 500;
      const page = paginated ? historyPage : 1;
      const totalRows = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${clauses.join(" OR ")}`).get(...values).count;
      const orderColumn = columns.includes("rollout_ordinal") ? "rollout_ordinal" : "rowid";
      const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${clauses.join(" OR ")} ORDER BY ${quoteIdentifier(orderColumn)} LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
      if (table === "thread_turns" && idColumn) for (const row of rows) if (row[idColumn] != null) turnIds.add(String(row[idColumn]));
      tables.push({ table, available: true, rows: rows.map(jsonSafe), ...(paginated ? { pagination: { page, pageSize, totalRows, hasMore: page * pageSize < totalRows } } : {}) });
    }
    return { available: true, tables };
  } catch (error) {
    return { available: false, tables: [], error: error.message };
  } finally {
    try { database?.close(); } catch { /* closing an unavailable connection is harmless */ }
  }
}

function resolveDatabasePath(home, filename) {
  const root = path.resolve(home);
  const candidate = path.join(root, filename);
  return realpath(candidate).then(async (resolved) => {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("database path is not a regular file");
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("database path escapes CODEX_SQLITE_HOME");
    return resolved;
  });
}

/** Index threads metadata for summaries, keyed only by a discovered rollout's session ID. */
export async function readThreadSummaries(sqliteHome, sessions) {
  const result = new Map();
  if (!sessions.length) return result;
  let database;
  try {
    const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
    const dbPath = await resolveDatabasePath(home, "state_5.sqlite");
    database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    const exists = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get("threads");
    if (!exists) return result;
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier("threads")})`).all().map((row) => row.name);
    const keyColumn = columns.find((column) => THREAD_KEYS.includes(column)) ?? columns.find((column) => column === "id");
    if (!keyColumn) return result;
    const accepted = ["title", "cwd", "model", "tokens_used", "source", "archived", "updated_at", "updated_at_ms"];
    const selected = [...new Set([keyColumn, ...accepted.filter((column) => columns.includes(column))])];
    const ids = [...new Set(sessions.map((session) => session.sessionId).filter((id) => typeof id === "string" && id))];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const rows = database.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier("threads")} WHERE ${quoteIdentifier(keyColumn)} IN (${batch.map(() => "?").join(",")}) LIMIT 500`).all(...batch);
      for (const row of rows) result.set(String(row[keyColumn]), jsonSafe(row));
    }
  } catch {
    // SQLite is supplementary: missing, corrupt or newer schemas leave JSONL summaries intact.
  } finally {
    try { database?.close(); } catch { /* ignore close errors */ }
  }
  return result;
}

/** Read only the three supported Codex databases. No other database is opened. */
export async function readSessionSupplement(sqliteHome, session, { historyPage = 1 } = {}) {
  const page = Number.isSafeInteger(historyPage) ? Math.min(10_000, Math.max(1, historyPage)) : 1;
  const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
  const wantedIds = [...new Set([session.sessionId, session.threadId].filter((value) => typeof value === "string" && value.length > 0))];
  const sources = [];
  for (const database of DATABASES) {
    const candidate = path.join(home, database.filename);
    try {
      const resolved = await resolveDatabasePath(home, database.filename);
      sources.push({ database: database.filename, ...readDatabase(resolved, database.tables, wantedIds, page) });
    } catch (error) {
      sources.push({ database: database.filename, available: false, tables: [], error: error.code === "ENOENT" ? "database not present" : error.message });
    }
  }
  return sources;
}
