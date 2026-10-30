import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { type JsonRecord, type Session } from "./types.js";
import type { AppLogger, LoggerContext } from "./logger.js";
import { withSQLiteSnapshot, type SQLiteSnapshotOptions } from "./sqlite-snapshot.js";

const DATABASES = [
  { filename: "state_5.sqlite", tables: ["threads"] },
  { filename: "thread_history_1.sqlite", tables: ["thread_turns", "thread_items"] },
  { filename: "goals_1.sqlite", tables: ["thread_goals"] },
 ] as const;
const THREAD_KEYS: readonly string[] = ["thread_id", "threadId", "thread_id_str", "thread_uuid"];
const ID_KEYS: readonly string[] = ["id", "thread_id", "threadId", "thread_id_str", "thread_uuid"];
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / HISTORY_PAGE_SIZE);

interface TableSnapshot {
  maxRowid: string;
  digest: string;
}

interface DatabaseSnapshot {
  identity?: string;
  error?: string;
  tables: Record<string, TableSnapshot | null>;
}

// Signed, bounded metadata rather than retained rows or open SQLite snapshots.
// Tokens are scoped to this process, configured home and discovered session.
const SNAPSHOT_KEY = randomBytes(32);
const MAX_SNAPSHOT_TOKEN_LENGTH = 8_192;

export class SupplementRevisionError extends Error {
  constructor() { super("SQLite 已有内容发生变化，请点击「刷新」加载新内容。"); }
}

function snapshotSignature(home: string, ids: string[], payload: string): string {
  return createHmac("sha256", SNAPSHOT_KEY).update(JSON.stringify([home, ids, payload])).digest("base64url");
}

function decodeSnapshot(revision: string, home: string, ids: string[]): DatabaseSnapshot[] {
  if (revision.length > MAX_SNAPSHOT_TOKEN_LENGTH) throw new SupplementRevisionError();
  const [payload, signature, extra] = revision.split(".");
  if (!payload || extra !== undefined || signature !== snapshotSignature(home, ids, payload)) throw new SupplementRevisionError();
  try {
    const snapshots: DatabaseSnapshot[] = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Array.isArray(snapshots) || snapshots.length !== DATABASES.length) throw new SupplementRevisionError();
    return snapshots;
  } catch { throw new SupplementRevisionError(); }
}

function jsonSafe(row: Record<string, SQLOutputValue>): JsonRecord {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Array.from(value) : value,
  ]));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

interface DatabaseTableResult {
  table: string;
  available: boolean;
  rows: JsonRecord[];
  reason?: string;
  pagination?: { page: number; pageSize: number; totalRows: number; hasMore: boolean };
}

interface DatabaseReadResult {
  available: boolean;
  tables: DatabaseTableResult[];
  error?: string;
  search?: HistorySearchResult;
}

interface HistorySearchQuery { query: string; afterIndex: number }
interface HistorySearchResult { rowIndex: number | null; page: number | null; totalRows: number }

function reportDatabaseError(logger: AppLogger | undefined, database: string, error: unknown, context?: LoggerContext): void {
  if (!logger) return;
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  const sqliteCode = typeof error === "object" && error !== null && "errcode" in error && typeof error.errcode === "number" ? error.errcode : undefined;
  const sqliteBaseCode = sqliteCode === undefined ? undefined : sqliteCode & 0xff;
  if (code === "ENOENT") logger.sourceState(database, "missing", "sqlite_unavailable");
  else if (code === "EACCES" || code === "EPERM") logger.sourceState(database, "degraded", "sqlite_permission");
  else if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" || sqliteCode === 11 || sqliteCode === 26) logger.sourceState(database, "degraded", "sqlite_corrupt");
  else if (["SQLITE_BUSY", "SQLITE_CANTOPEN", "ENOSPC", "EIO"].includes(code) || [5, 6, 14].includes(sqliteBaseCode ?? -1)) logger.sourceState(database, "degraded", "sqlite_unavailable");
  else logger.sourceState(database, "degraded", "sqlite_schema");
  void context;
}

function safeDatabaseError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  const sqliteCode = typeof error === "object" && error !== null && "errcode" in error && typeof error.errcode === "number" ? error.errcode : undefined;
  if (error instanceof Error && error.message === "SQLite source file escapes CODEX_SQLITE_HOME") return error.message;
  if (code === "ENOENT") return "database not present";
  if (code === "EACCES" || code === "EPERM") return "database access unavailable";
  if (code === "SQLITE_BUSY") return "database changed during snapshot";
  if (sqliteCode === 11 || sqliteCode === 26 || code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return "database corrupt";
  return "database unavailable";
}

function readDatabase(
  dbPath: string, tableNames: readonly string[], wantedIds: string[], historyPage = 1,
  snapshot?: { state: DatabaseSnapshot; expected: boolean },
  search?: HistorySearchQuery,
  databaseName?: string,
  logger?: AppLogger,
  context?: LoggerContext,
): DatabaseReadResult {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    // A read transaction keeps counts, fingerprints and page rows on the same
    // WAL snapshot while writers continue. No write transaction is opened.
    database.exec("BEGIN DEFERRED");
    const existingTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
    const tables = [];
    let searchResult: HistorySearchResult | undefined;
    const turnIds = new Set<string>();
    let turnRelation: { id: string; thread: string; rowid: string; maxRowid: string } | undefined;
    for (const table of tableNames) {
      if (snapshot?.expected && snapshot.state.tables[table] === null) {
        tables.push({ table, available: false, rows: [], reason: "table not present in this schema" });
        continue;
      }
      if (!existingTables.has(table)) {
        if (snapshot?.expected) throw new SupplementRevisionError();
        if (snapshot) snapshot.state.tables[table] = null;
        tables.push({ table, available: false, rows: [], reason: "table not present in this schema" });
        continue;
      }
      const schema = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
      const columns = schema.map((row) => String(row.name));
      if (!columns.length) continue;
      const threadColumn = columns.find((column) => THREAD_KEYS.includes(column)) ?? (table === "threads" ? columns.find((column) => column === "id") : undefined);
      const idColumn = table === "thread_turns" ? columns.find((column) => ["turn_id", "id"].includes(column)) : columns.find((column) => ID_KEYS.includes(column));
      const parentColumn = table === "thread_items" ? columns.find((column) => ["turn_id", "thread_turn_id"].includes(column)) : null;
      const clauses = [];
      const values: SQLInputValue[] = [];
      if (threadColumn && wantedIds.length) {
        clauses.push(`${quoteIdentifier(threadColumn)} IN (${wantedIds.map(() => "?").join(",")})`);
        values.push(...wantedIds);
      }
      if (!threadColumn && parentColumn && snapshot && turnRelation) {
        clauses.push(`${quoteIdentifier(parentColumn)} IN (SELECT ${quoteIdentifier(turnRelation.id)} FROM thread_turns WHERE ${quoteIdentifier(turnRelation.thread)} IN (${wantedIds.map(() => "?").join(",")}) AND ${quoteIdentifier(turnRelation.rowid)} <= ?)`);
        values.push(...wantedIds, BigInt(turnRelation.maxRowid));
      } else if (!threadColumn && parentColumn && turnIds.size) {
        const ids = [...turnIds];
        clauses.push(`${quoteIdentifier(parentColumn)} IN (${ids.map(() => "?").join(",")})`);
        values.push(...ids);
      }
      if (!clauses.length) {
        if (snapshot) {
          const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
          if (snapshot.expected && snapshot.state.tables[table]?.digest !== digest) throw new SupplementRevisionError();
          snapshot.state.tables[table] = { maxRowid: "0", digest };
        }
        tables.push({ table, available: true, rows: [], reason: "schema has no supported session relation column" });
        continue;
      }
      const paginated = table === "thread_turns" || table === "thread_items";
      const pageSize = HISTORY_PAGE_SIZE;
      const page = paginated ? historyPage : 1;
      const rowid = ["rowid", "_rowid_", "oid"].find((name) => !columns.includes(name));
      if (snapshot) {
        if (!rowid) throw new Error("schema has no supported rowid column");
        const previous = snapshot.state.tables[table];
        const maximumQuery = database.prepare(`SELECT COALESCE(MAX(${quoteIdentifier(rowid)}), 0) AS maximum FROM ${quoteIdentifier(table)} WHERE (${clauses.join(" OR ")})`);
        maximumQuery.setReadBigInts(true);
        const maximum = snapshot.expected ? previous?.maxRowid : String(maximumQuery.get(...values)?.maximum ?? 0);
        if (maximum === undefined) throw new SupplementRevisionError();
        const where = `(${clauses.join(" OR ")}) AND ${quoteIdentifier(rowid)} <= ?`;
        const hash = createHash("sha256").update(JSON.stringify(schema));
        const statement = database.prepare(`SELECT ${quoteIdentifier(rowid)}, * FROM ${quoteIdentifier(table)} WHERE ${where} ORDER BY ${quoteIdentifier(rowid)}`);
        statement.setReadBigInts(true);
        // Hash untruncated values one row at a time; never keep the history in memory.
        for (const row of statement.iterate(...values, BigInt(maximum))) {
          hash.update(JSON.stringify(row, (_key, value: unknown) => typeof value === "bigint" ? ["integer", String(value)] : value instanceof Uint8Array ? ["bytes", Buffer.from(value).toString("base64")] : value));
          hash.update("\n");
        }
        const digest = hash.digest("hex");
        if (snapshot.expected && previous?.digest !== digest) throw new SupplementRevisionError();
        snapshot.state.tables[table] = { maxRowid: maximum, digest };
        if (table === "thread_turns" && idColumn && threadColumn) turnRelation = { id: idColumn, thread: threadColumn, rowid, maxRowid: maximum };
        clauses.splice(0, clauses.length, where);
        values.push(BigInt(maximum));
      }
      const countValue = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${clauses.join(" OR ")}`).get(...values)?.count;
      const totalRows = typeof countValue === "number" || typeof countValue === "bigint" || typeof countValue === "string"
        ? Number(countValue)
        : 0;
      const orderColumn = columns.includes("rollout_ordinal") ? "rollout_ordinal" : "rowid";
      const order = snapshot && rowid ? `${quoteIdentifier(orderColumn)}, ${quoteIdentifier(rowid)}` : quoteIdentifier(orderColumn);
      const query = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${clauses.join(" OR ")} ORDER BY ${order}`;
      if (search) {
        if (table === "thread_items") {
          let first: number | null = null;
          let next: number | null = null;
          let index = 0;
          const statement = database.prepare(query);
          statement.setReadBigInts(true);
          for (const row of statement.iterate(...values)) {
            index += 1;
            const matches = JSON.stringify(jsonSafe(row)).includes(search.query)
              || Object.values(row).some((value) => typeof value === "string" && value.includes(search.query));
            if (!matches) continue;
            first ??= index;
            if (index > search.afterIndex) { next = index; break; }
          }
          const rowIndex = next ?? first;
          searchResult = { rowIndex, page: rowIndex === null ? null : Math.ceil(rowIndex / pageSize), totalRows };
        }
        tables.push({ table, available: true, rows: [] });
        continue;
      }
      const rows = paginated
        ? database.prepare(`${query} LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize)
        : database.prepare(query).all(...values);
      if (table === "thread_turns" && idColumn) for (const row of rows) if (row[idColumn] != null) turnIds.add(String(row[idColumn]));
      tables.push({ table, available: true, rows: rows.map(jsonSafe), ...(paginated ? { pagination: { page, pageSize, totalRows, hasMore: page * pageSize < totalRows } } : {}) });
    }
    database.exec("COMMIT");
    if (databaseName) {
      const degraded = tables.some((table) => !table.available || Boolean(table.reason));
      logger?.sourceState(databaseName, degraded ? "degraded" : "available", degraded ? "sqlite_schema" : undefined);
    }
    return { available: true, tables, ...(searchResult ? { search: searchResult } : {}) };
  } catch (error: unknown) {
    if (snapshot?.expected) throw new SupplementRevisionError();
    if (databaseName) reportDatabaseError(logger, databaseName, error, context);
    return { available: false, tables: [], error: safeDatabaseError(error) };
  } finally {
    try { database?.close(); } catch { /* closing an unavailable connection is harmless */ }
  }
}

export async function readSessionSupplementSnapshot(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  { historyPage = 1, revision, historySearch }: { historyPage?: number; revision?: string; historySearch?: HistorySearchQuery } = {},
  logger?: AppLogger,
  context?: LoggerContext,
  snapshotOptions: SQLiteSnapshotOptions = { codexHome: sqliteHome, sqliteHome },
): Promise<{ supplement: Array<{ database: string } & DatabaseReadResult>; supplementRevision: string }> {
  const page = Number.isSafeInteger(historyPage) ? Math.min(MAX_HISTORY_PAGE, Math.max(1, historyPage)) : 1;
  const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
  const ids = [...new Set([session.sessionId, session.threadId].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const snapshots = revision === undefined ? DATABASES.map((): DatabaseSnapshot => ({ tables: {} })) : decodeSnapshot(revision, home, ids);
  const supplement: Array<{ database: string } & DatabaseReadResult> = [];
  for (const [i, { filename, tables }] of DATABASES.entries()) {
    // History navigation must neither validate nor reload mutable thread/goal metadata.
    if (revision !== undefined && filename !== "thread_history_1.sqlite") continue;
    const snapshot = snapshots[i];
    if (revision !== undefined && snapshot.error !== undefined) {
      if (snapshot.error === "database not present") logger?.sourceState(filename, "missing", "sqlite_unavailable");
      else logger?.sourceState(filename, "degraded", "sqlite_unavailable");
      supplement.push({ database: filename, available: false, tables: [], error: snapshot.error });
      continue;
    }
    try {
      const { value: result } = await withSQLiteSnapshot(filename, snapshotOptions, (copyPath, identity) => {
        if (revision !== undefined && snapshot.identity !== identity.token) throw new SupplementRevisionError();
        snapshot.identity = identity.token;
        return readDatabase(
          copyPath,
          tables,
          ids,
          page,
          filename === "thread_history_1.sqlite" ? { state: snapshot, expected: revision !== undefined } : undefined,
          filename === "thread_history_1.sqlite" ? historySearch : undefined,
          filename,
          logger,
          context,
        );
      });
      if (!result.available) snapshot.error = result.error ?? "database unavailable";
      supplement.push({ database: filename, ...result });
    } catch (error: unknown) {
      if (error instanceof SupplementRevisionError || revision !== undefined) throw new SupplementRevisionError();
      reportDatabaseError(logger, filename, error, context);
      snapshot.error = safeDatabaseError(error);
      supplement.push({ database: filename, available: false, tables: [], error: snapshot.error });
    }
  }
  const payload = Buffer.from(JSON.stringify(snapshots)).toString("base64url");
  return { supplement, supplementRevision: revision ?? `${payload}.${snapshotSignature(home, ids, payload)}` };
}

/** Index threads metadata for summaries, keyed only by a discovered rollout's session ID. */
export async function searchSessionHistory(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  revision: string,
  query: string,
  afterIndex = 0,
  logger?: AppLogger,
  context?: LoggerContext,
  snapshotOptions: SQLiteSnapshotOptions = { codexHome: sqliteHome, sqliteHome },
): Promise<HistorySearchResult> {
  if (!query || query.length > 256 || !Number.isSafeInteger(afterIndex) || afterIndex < 0) {
    throw new Error("SQLite 查找文本需为 1 到 256 个 UTF-16 代码单元，起点需为非负安全整数。");
  }
  const { supplement } = await readSessionSupplementSnapshot(sqliteHome, session, {
    revision, historySearch: { query, afterIndex },
  }, logger, context, snapshotOptions);
  const history = supplement.find((source) => source.database === "thread_history_1.sqlite");
  const items = history?.tables.find((table) => table.table === "thread_items");
  if (!history?.available || !items?.available || items.reason) {
    throw new Error(history?.error ?? items?.reason ?? "SQLite 历史对话不可用。");
  }
  return history.search ?? { rowIndex: null, page: null, totalRows: 0 };
}

export async function readThreadSummaries(
  sqliteHome: string,
  sessions: Session[],
  logger?: AppLogger,
  context?: LoggerContext,
  snapshotOptions: SQLiteSnapshotOptions = { codexHome: sqliteHome, sqliteHome },
): Promise<Map<string, JsonRecord>> {
  if (sessions.length === 0) return new Map();
  const fallback = new Map<string, JsonRecord>();
  try {
    const { value } = await withSQLiteSnapshot("state_5.sqlite", snapshotOptions, (copyPath) => {
      const result = new Map<string, JsonRecord>();
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(copyPath, { readOnly: true, enableForeignKeyConstraints: false });
        const exists = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get("threads");
        if (!exists) { logger?.sourceState("state_5.sqlite", "degraded", "sqlite_schema"); return result; }
        const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier("threads")})`).all().map((row) => String(row.name));
        const keyColumn = columns.find((column) => THREAD_KEYS.includes(column)) ?? columns.find((column) => column === "id");
        if (!keyColumn) { logger?.sourceState("state_5.sqlite", "degraded", "sqlite_schema"); return result; }
        const accepted = ["name", "title", "preview", "first_user_message", "cwd", "model", "tokens_used", "source", "archived", "updated_at", "updated_at_ms"];
        const selected = [...new Set([keyColumn, ...accepted.filter((column) => columns.includes(column))])];
        const ids = [...new Set(sessions.map((session) => session.sessionId).filter((id): id is string => typeof id === "string" && id.length > 0))];
        for (let offset = 0; offset < ids.length; offset += 400) {
          const batch = ids.slice(offset, offset + 400);
          const rows = database.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier("threads")} WHERE ${quoteIdentifier(keyColumn)} IN (${batch.map(() => "?").join(",")}) LIMIT 500`).all(...batch);
          for (const row of rows) result.set(String(row[keyColumn]), jsonSafe(row));
        }
        logger?.sourceState("state_5.sqlite", "available");
        return result;
      } catch (error) {
        // SQLite is supplementary: missing, corrupt or newer schemas leave JSONL summaries intact.
        reportDatabaseError(logger, "state_5.sqlite", error, context);
        return result;
      } finally {
        try { database?.close(); } catch { /* ignore close errors */ }
      }
    });
    return value;
  } catch (error) {
    reportDatabaseError(logger, "state_5.sqlite", error, context);
    return fallback;
  }
}

/** Read only the three supported Codex databases. No other database is opened. */
export async function readSessionSupplement(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  { historyPage = 1 }: { historyPage?: number } = {},
  logger?: AppLogger,
  context?: LoggerContext,
  snapshotOptions: SQLiteSnapshotOptions = { codexHome: sqliteHome, sqliteHome },
): Promise<Array<{ database: string } & DatabaseReadResult>> {
  const page = Number.isSafeInteger(historyPage) ? Math.min(MAX_HISTORY_PAGE, Math.max(1, historyPage)) : 1;
  const wantedIds = [...new Set([session.sessionId, session.threadId].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const sources: Array<{ database: string } & DatabaseReadResult> = [];
  for (const database of DATABASES) {
    try {
      const { value } = await withSQLiteSnapshot(database.filename, snapshotOptions, (copyPath) =>
        readDatabase(copyPath, database.tables, wantedIds, page, undefined, undefined, database.filename, logger, context));
      sources.push({ database: database.filename, ...value });
    } catch (error: unknown) {
      reportDatabaseError(logger, database.filename, error, context);
      sources.push({ database: database.filename, available: false, tables: [], error: safeDatabaseError(error) });
    }
  }
  return sources;
}
