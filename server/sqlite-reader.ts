import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { errorMessage, type JsonRecord, type Session } from "./types.js";

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

function readDatabase(
  dbPath: string, tableNames: readonly string[], wantedIds: string[], historyPage = 1,
  snapshot?: { state: DatabaseSnapshot; expected: boolean },
  search?: HistorySearchQuery,
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
    return { available: true, tables, ...(searchResult ? { search: searchResult } : {}) };
  } catch (error: unknown) {
    if (snapshot?.expected) throw new SupplementRevisionError();
    return { available: false, tables: [], error: errorMessage(error) };
  } finally {
    try { database?.close(); } catch { /* closing an unavailable connection is harmless */ }
  }
}

export async function readSessionSupplementSnapshot(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  { historyPage = 1, revision, historySearch }: { historyPage?: number; revision?: string; historySearch?: HistorySearchQuery } = {},
): Promise<{ supplement: Array<{ database: string } & DatabaseReadResult>; supplementRevision: string }> {
  const page = Number.isSafeInteger(historyPage) ? Math.min(MAX_HISTORY_PAGE, Math.max(1, historyPage)) : 1;
  const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
  const ids = [...new Set([session.sessionId, session.threadId].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const snapshots = revision === undefined ? DATABASES.map((): DatabaseSnapshot => ({ tables: {} })) : decodeSnapshot(revision, home, ids);
  const supplement: Array<{ database: string } & DatabaseReadResult> = [];
  for (const [i, { filename, tables }] of DATABASES.entries()) {
    // History navigation must neither validate nor reload mutable thread/goal
    // metadata. The browser keeps those sources from the original window.
    if (revision !== undefined && filename !== "thread_history_1.sqlite") continue;
    const snapshot = snapshots[i];
    if (revision !== undefined && snapshot.error !== undefined) {
      supplement.push({ database: filename, available: false, tables: [], error: snapshot.error });
      continue;
    }
    try {
      const resolved = await resolveDatabasePath(home, filename);
      const info = await stat(resolved, { bigint: true });
      const identity = createHash("sha256").update(`${info.dev}:${info.ino}`).digest("hex");
      if (revision !== undefined && snapshot.identity !== identity) throw new SupplementRevisionError();
      snapshot.identity = identity;
      const result = readDatabase(resolved, tables, ids, page, filename === "thread_history_1.sqlite" ? { state: snapshot, expected: revision !== undefined } : undefined, filename === "thread_history_1.sqlite" ? historySearch : undefined);
      const after = await stat(resolved, { bigint: true });
      if (info.dev !== after.dev || info.ino !== after.ino) throw new SupplementRevisionError();
      if (!result.available) snapshot.error = result.error ?? "database unavailable";
      supplement.push({ database: filename, ...result });
    } catch (error: unknown) {
      if (error instanceof SupplementRevisionError || revision !== undefined) throw new SupplementRevisionError();
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      snapshot.error = code === "ENOENT" ? "database not present" : errorMessage(error);
      supplement.push({ database: filename, available: false, tables: [], error: snapshot.error });
    }
  }
  const payload = Buffer.from(JSON.stringify(snapshots)).toString("base64url");
  return { supplement, supplementRevision: revision ?? `${payload}.${snapshotSignature(home, ids, payload)}` };
}

function resolveDatabasePath(home: string, filename: string): Promise<string> {
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
export async function searchSessionHistory(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  revision: string,
  query: string,
  afterIndex = 0,
): Promise<HistorySearchResult> {
  if (!query || query.length > 256 || !Number.isSafeInteger(afterIndex) || afterIndex < 0) {
    throw new Error("SQLite 查找文本需为 1 到 256 个 UTF-16 代码单元，起点需为非负安全整数。");
  }
  const { supplement } = await readSessionSupplementSnapshot(sqliteHome, session, {
    revision, historySearch: { query, afterIndex },
  });
  const history = supplement.find((source) => source.database === "thread_history_1.sqlite");
  const items = history?.tables.find((table) => table.table === "thread_items");
  if (!history?.available || !items?.available || items.reason) {
    throw new Error(history?.error ?? items?.reason ?? "SQLite 历史对话不可用。");
  }
  return history.search ?? { rowIndex: null, page: null, totalRows: 0 };
}

export async function readThreadSummaries(sqliteHome: string, sessions: Session[]): Promise<Map<string, JsonRecord>> {
  const result = new Map<string, JsonRecord>();
  if (!sessions.length) return result;
  let database: DatabaseSync | undefined;
  try {
    const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
    const dbPath = await resolveDatabasePath(home, "state_5.sqlite");
    database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    const exists = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get("threads");
    if (!exists) return result;
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier("threads")})`).all().map((row) => String(row.name));
    const keyColumn = columns.find((column) => THREAD_KEYS.includes(column)) ?? columns.find((column) => column === "id");
    if (!keyColumn) return result;
    const accepted = ["name", "title", "preview", "first_user_message", "cwd", "model", "tokens_used", "source", "archived", "updated_at", "updated_at_ms"];
    const selected = [...new Set([keyColumn, ...accepted.filter((column) => columns.includes(column))])];
    const ids = [...new Set(sessions.map((session) => session.sessionId).filter((id): id is string => typeof id === "string" && id.length > 0))];
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
export async function readSessionSupplement(
  sqliteHome: string,
  session: Pick<Session, "sessionId"> & { threadId?: string },
  { historyPage = 1 }: { historyPage?: number } = {},
): Promise<Array<{ database: string } & DatabaseReadResult>> {
  const page = Number.isSafeInteger(historyPage) ? Math.min(MAX_HISTORY_PAGE, Math.max(1, historyPage)) : 1;
  const home = await realpath(sqliteHome).catch(() => path.resolve(sqliteHome));
  const wantedIds = [...new Set([session.sessionId, session.threadId].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const sources: Array<{ database: string } & DatabaseReadResult> = [];
  for (const database of DATABASES) {
    try {
      const resolved = await resolveDatabasePath(home, database.filename);
      sources.push({ database: database.filename, ...readDatabase(resolved, database.tables, wantedIds, page) });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      sources.push({ database: database.filename, available: false, tables: [], error: code === "ENOENT" ? "database not present" : errorMessage(error) });
    }
  }
  return sources;
}
