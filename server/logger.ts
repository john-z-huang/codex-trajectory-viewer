import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const LOG_SCHEMA_VERSION = 1;
export const DEFAULT_LOG_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  retentionDays: 14,
  maxTotalBytes: 512 * 1024 * 1024,
  maxQueueEvents: 1000,
  maxQueueBytes: 1024 * 1024,
  closeTimeoutMs: 1500,
});

export type LogSource = "server" | "http" | "browser";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LoggerContext = Partial<Pick<SafeLogRecord, "operation_id" | "request_id" | "client_id" | "tab_id" | "client_time" | "client_seq" | "event_id">>;
export type SafeLogRecord = {
  schema_version: number;
  time: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  instance_id: string;
  seq: number;
  operation_id?: string;
  request_id?: string;
  client_id?: string;
  tab_id?: string;
  client_time?: string;
  client_seq?: number;
  event_id?: string;
  [key: string]: unknown;
};

type FieldKind = "number" | "boolean" | "enum" | "id" | "stack" | "ui_source";
type EventSpec = { source: LogSource; level: LogLevel; fields: Record<string, FieldKind> };
type SafeRecordPayload = { level: LogLevel; source: LogSource; event: string; [key: string]: unknown };
const ENUMS: Record<string, readonly string[]> = {
  route: ["sessions_list", "sessions_detail", "sessions_window", "sessions_page", "sessions_raw", "sessions_download", "sessions_search", "sessions_history", "sessions_history_search", "static", "unknown_api", "method_not_allowed", "logs_ingest"],
  outcome: ["sent", "aborted", "failed", "success", "failure", "cancelled", "stale", "degraded", "rejected", "dispatched", "queued"],
  classification: ["normal", "expected_stale", "client_error", "server_error"],
  error_type: ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "RolloutReaderError", "SupplementRevisionError", "SQLiteError", "NetworkError", "UnknownError"],
  error_code: ["internal_error", "read_error", "stale_revision", "invalid_json", "invalid_event", "invalid_origin", "invalid_content_type", "payload_too_large", "too_many_events", "rate_limited", "deduplicated", "log_write_failed", "log_root_unsafe", "sqlite_unavailable", "sqlite_schema", "sqlite_corrupt", "sqlite_permission", "aborted", "queue_full", "listen_failed", "unhandled_rejection", "window_error", "render_error", "recoverable_render_error"],
  database: ["state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite"],
  state: ["available", "missing", "degraded", "recovered", "error"],
  ui_action: ["open", "reactivate", "close", "switch", "filter", "page", "jump", "search", "expand", "collapse", "fragment", "start", "success", "failure", "cancel", "precheck", "dispatch", "stream_start", "stream_end", "stream_abort", "local_dispatch"],
  ui_source: ["jsonl", "sqlite", "list", "history"],
  ui_result: ["success", "failure", "cancelled", "stale", "degraded", "dispatched"],
  ui_error: ["network", "http", "abort", "parse", "clipboard", "render", "unknown"],
};

const STACK_MODULES = ["index", "logger", "session-api", "session-discovery", "sqlite-reader", "rollout-reader", "static-files", "subagents"] as const;
type StackModule = typeof STACK_MODULES[number];

const SPECS: Record<string, EventSpec> = {
  server_start: { source: "server", level: "info", fields: {} },
  server_shutdown: { source: "server", level: "info", fields: {} },
  listen_failed: { source: "server", level: "error", fields: { error_type: "enum", error_code: "enum", stack: "stack" } },
  discovery_complete: { source: "server", level: "info", fields: { sessions: "number", dirs_skipped: "number", files_skipped: "number", missing_count: "number", permission_count: "number", unsafe_count: "number", io_count: "number" } },
  sqlite_source_state: { source: "server", level: "info", fields: { database: "enum", state: "enum", error_code: "enum" } },
  sqlite_source_warning: { source: "server", level: "warn", fields: { database: "enum", state: "enum", error_code: "enum" } },
  reader_index: { source: "server", level: "info", fields: { line_count: "number", total_bytes: "number", index_bytes: "number", stride: "number", summary_complete: "boolean" } },
  request_processing_error: { source: "server", level: "error", fields: { route: "enum", error_type: "enum", error_code: "enum", stack: "stack" } },
  request_cancelled: { source: "server", level: "debug", fields: { route: "enum" } },
  expected_stale_snapshot: { source: "server", level: "info", fields: { route: "enum" } },
  logger_drop_summary: { source: "server", level: "warn", fields: { dropped_count: "number", queued_count: "number" } },
  http_request_terminal: { source: "http", level: "info", fields: { route: "enum", status: "number", bytes: "number", duration_ms: "number", outcome: "enum", classification: "enum" } },
  http_request_failed: { source: "http", level: "error", fields: { route: "enum", status: "number", bytes: "number", duration_ms: "number", outcome: "enum", classification: "enum" } },
  http_request_aborted: { source: "http", level: "debug", fields: { route: "enum", status: "number", bytes: "number", duration_ms: "number", outcome: "enum", classification: "enum" } },
  browser_refresh: { source: "browser", level: "info", fields: { action: "enum", outcome: "enum", duration_ms: "number", result_count: "number", operation_id: "id" } },
  browser_list_request: { source: "browser", level: "info", fields: { status: "number", duration_ms: "number", queue_ms: "number", network_ms: "number", server_ms: "number", outcome: "enum", error_code: "enum", result_count: "number", operation_id: "id" } },
  browser_detail_request: { source: "browser", level: "info", fields: { route: "enum", status: "number", queue_ms: "number", network_ms: "number", server_ms: "number", outcome: "enum", error_code: "enum", operation_id: "id" } },
  browser_tab: { source: "browser", level: "info", fields: { action: "enum", tab_id: "id", operation_id: "id" } },
  browser_source: { source: "browser", level: "info", fields: { action: "enum", data_source: "ui_source", tab_id: "id", operation_id: "id" } },
  browser_filter: { source: "browser", level: "info", fields: { data_source: "ui_source", query_length: "number", result_count: "number", hidden_count: "number", operation_id: "id" } },
  browser_navigation: { source: "browser", level: "info", fields: { action: "enum", data_source: "ui_source", query_length: "number", result_count: "number", page: "number", line: "number", offset: "number", count: "number", outcome: "enum", operation_id: "id" } },
  browser_raw: { source: "browser", level: "info", fields: { action: "enum", data_source: "ui_source", page: "number", line: "number", offset: "number", outcome: "enum", operation_id: "id" } },
  browser_copy: { source: "browser", level: "info", fields: { action: "enum", data_source: "ui_source", count: "number", outcome: "enum", operation_id: "id" } },
  browser_download: { source: "browser", level: "info", fields: { action: "enum", data_source: "ui_source", line: "number", offset: "number", count: "number", outcome: "enum", operation_id: "id" } },
  browser_error: { source: "browser", level: "warn", fields: { error_type: "enum", error_code: "enum", action: "enum", operation_id: "id" } },
};

export const BROWSER_EVENT_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(SPECS).filter(([, spec]) => spec.source === "browser").map(([event, spec]) => [event, Object.keys(spec.fields)]),
));

export interface LoggerSink {
  write(record: SafeLogRecord, serialized: string): Promise<void>;
  close?(): Promise<void>;
}
export interface AppLogger {
  emit(event: string, fields?: Record<string, unknown>, context?: LoggerContext): void;
  acceptBrowserBatch(events: unknown[]): Promise<{ accepted: number; duplicate: number; rejected: number }>;
  sourceState(database: string, state: "available" | "missing" | "degraded" | "error", code?: string): void;
  status(): { healthy: boolean; queued: number; dropped: number; lastErrorCode: string | null };
  close(timeoutMs?: number): Promise<void>;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function safeTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
}
function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1_000_000_000) : undefined;
}
function safeEnum(name: string, value: unknown): string | undefined {
  const alias: Record<string, string> = { action: "ui_action", data_source: "ui_source", result: "ui_result" };
  const allowed = ENUMS[name] ?? ENUMS[alias[name]];
  return typeof value === "string" && allowed?.includes(value) ? value : undefined;
}

function validBrowserInput(input: Record<string, unknown>, event: string): boolean {
  const spec = SPECS[event];
  if (!spec || spec.source !== "browser") return false;
  const metadata = new Set(["event", "client_id", "tab_id", "client_time", "client_seq", "event_id", "operation_id", "request_id"]);
  const allowed = new Set([...metadata, ...Object.keys(spec.fields)]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return false;
  for (const key of ["client_id", "event_id"] as const) if (!safeId(input[key])) return false;
  for (const key of ["tab_id", "operation_id", "request_id"] as const) if (input[key] !== undefined && !safeId(input[key])) return false;
  if (input.client_time !== undefined && !safeTime(input.client_time)) return false;
  if (input.client_seq !== undefined && (safeNumber(input.client_seq) === undefined || !Number.isSafeInteger(input.client_seq))) return false;
  for (const [key, value] of Object.entries(input)) {
    const kind = spec.fields[key];
    if (!kind) continue;
    if (kind === "enum" && !safeEnum(key, value)) return false;
    if (kind === "number" && (safeNumber(value) === undefined || (key === "status" && (!Number.isInteger(value) || Number(value) < 100 || Number(value) > 599)))) return false;
    if (kind === "boolean" && typeof value !== "boolean") return false;
    if (kind === "id" && !safeId(value)) return false;
    if (kind === "ui_source" && !safeEnum("data_source", value)) return false;
  }
  return true;
}

export function validateBrowserBatch(events: unknown[]): boolean {
  if (!Array.isArray(events) || events.length < 1 || events.length > 50) return false;
  return events.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const input = raw as Record<string, unknown>;
    return typeof input.event === "string" && validBrowserInput(input, input.event);
  });
}

function stackFrames(error: unknown): Array<{ module: StackModule; line: number; column: number }> {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const result: Array<{ module: StackModule; line: number; column: number }> = [];
  for (const line of error.stack.split("\n").slice(1, 24)) {
    const match = line.match(/(?:\/|\\)(?:server|server-dist)(?:\/|\\)([a-z-]+)\.(?:ts|js):(\d+):(\d+)/);
    if (!match || !STACK_MODULES.includes(match[1] as StackModule)) continue;
    result.push({ module: match[1] as StackModule, line: Math.min(Number(match[2]), 10_000_000), column: Math.min(Number(match[3]), 100_000) });
    if (result.length >= 8) break;
  }
  return result;
}

function levelForRecord(event: string, input: Record<string, unknown>, defaultLevel: LogLevel): LogLevel {
  const outcome = safeEnum("outcome", input.outcome);
  const action = safeEnum("action", input.action);
  if (event === "browser_error") return input.error_code === "recoverable_render_error" ? "warn" : "error";
  if (action === "cancel" || outcome === "aborted" || outcome === "cancelled") return "debug";
  if (outcome === "failed" || outcome === "failure" || action === "failure") return "error";
  if (outcome === "degraded") return "warn";
  return defaultLevel;
}

function sanitizeRecord(event: string, input: Record<string, unknown>, context: LoggerContext): SafeRecordPayload | null {
  const spec = SPECS[event];
  if (!Object.hasOwn(SPECS, event) || !spec) return null;
  const fields: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(spec.fields)) {
    const value = input[key];
    if (kind === "enum") {
      const normalized = safeEnum(key, value);
      if (normalized) fields[key] = normalized;
    } else if (kind === "number") {
      const normalized = safeNumber(value);
      if (normalized !== undefined && (key !== "status" || (Number.isInteger(normalized) && normalized >= 100 && normalized <= 599))) fields[key] = normalized;
    } else if (kind === "boolean" && typeof value === "boolean") fields[key] = value;
    else if (kind === "id" && safeId(value)) fields[key] = value;
    else if (kind === "ui_source" && safeEnum("data_source", value)) fields[key] = value;
    else if (kind === "stack") fields[key] = Array.isArray(value)
      ? value.slice(0, 8).flatMap((frame) => {
        if (!frame || typeof frame !== "object") return [];
        const item = frame as Record<string, unknown>;
        return STACK_MODULES.includes(item.module as StackModule) && Number.isSafeInteger(item.line) && Number.isSafeInteger(item.column)
          ? [{ module: item.module, line: item.line, column: item.column }]
          : [];
      })
      : stackFrames(value);
  }
  const record: Record<string, unknown> = { level: levelForRecord(event, input, spec.level), source: spec.source, event, ...fields };
  for (const name of ["operation_id", "request_id", "client_id", "tab_id", "event_id"] as const) {
    const value = context?.[name] ?? (name === "operation_id" ? input[name] : undefined);
    if (safeId(value)) record[name] = value;
  }
  if (safeTime(context?.client_time ?? input.client_time)) record.client_time = context?.client_time ?? input.client_time;
  const seq = safeNumber(context?.client_seq ?? input.client_seq);
  if (seq !== undefined && Number.isSafeInteger(seq)) record.client_seq = seq;
  return record as SafeRecordPayload;
}

function localDate(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
function localTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const wallClock = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().replace(/Z$/, "");
  return `${wallClock}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
function calendarCutoff(date: Date, retentionDays: number): string {
  const cutoff = new Date(date.getTime());
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(0, Math.trunc(retentionDays) - 1));
  return localDate(cutoff);
}
function overlaps(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

async function resolveThroughMissing(value: string): Promise<string> {
  let candidate = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await realpath(candidate);
      return path.resolve(real, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function rejectSymlinkAncestors(root: string): Promise<void> {
  const absolute = path.resolve(root);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("log_root_unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function assertLogRootSafe(root: string, home: string, sqliteHome: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const sources = [path.resolve(home), path.resolve(sqliteHome)];
  const [resolvedRoot, ...resolvedSources] = await Promise.all([absoluteRoot, ...sources].map(resolveThroughMissing));
  if (sources.some((source) => overlaps(absoluteRoot, source)) || resolvedSources.some((source) => overlaps(resolvedRoot, source))) {
    throw new Error("log_root_unsafe");
  }
  await rejectSymlinkAncestors(absoluteRoot);
  try {
    const info = await lstat(absoluteRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("log_root_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

type FileLogOptions = {
  minLevel?: LogLevel;
  root?: string;
  home?: string;
  sqliteHome?: string;
  clock?: () => Date;
  limits?: Partial<typeof DEFAULT_LOG_LIMITS>;
  instanceId?: string;
  lockWaitMs?: number;
};

class FileLogSink implements LoggerSink {
  readonly root: string;
  readonly home: string;
  readonly sqliteHome: string;
  readonly instanceId: string;
  readonly clock: () => Date;
  readonly limits: typeof DEFAULT_LOG_LIMITS;
  readonly lockWaitMs: number;
  private readonly segments = new Map<string, { date: string; source: LogSource; name: string; size: number; marker: string }>();
  private segmentSequence = 0;
  private closed = false;

  constructor(options: FileLogOptions = {}) {
    this.root = path.resolve(options.root ?? path.join(os.homedir(), ".local", "state", "codex-trajectory-viewer", "logs"));
    this.home = path.resolve(options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
    this.sqliteHome = path.resolve(options.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? this.home);
    this.instanceId = options.instanceId ?? randomUUID().replaceAll("-", "");
    this.clock = options.clock ?? (() => new Date());
    this.limits = { ...DEFAULT_LOG_LIMITS, ...options.limits };
    this.lockWaitMs = options.lockWaitMs ?? 5000;
  }

  async write(record: SafeLogRecord, serialized: string): Promise<void> {
    if (this.closed) throw new Error("log_write_failed");
    await assertLogRootSafe(this.root, this.home, this.sqliteHome);
    const date = localDate(new Date(record.time));
    const lineBytes = Buffer.byteLength(serialized, "utf8");
    if (lineBytes > this.limits.maxFileBytes) throw new Error("log_write_failed");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.ensurePrivateDirectory(this.root);
    await this.withLock(async () => {
      for (const segment of [...this.segments.values()]) {
        if (segment.date !== date) await this.closeSegment(path.join(this.root, segment.date), segment);
      }
      await this.cleanOld(date);
      const dayDir = path.join(this.root, date);
      await mkdir(dayDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await this.ensurePrivateDirectory(dayDir);
      let segment = this.segments.get(`${date}/${record.source}`);
      if (segment) {
        const current = segment;
        try {
          const info = await lstat(path.join(dayDir, current.name));
          const markerInfo = await lstat(path.join(dayDir, current.marker));
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1 || (markerInfo.mode & 0o777) !== 0o600 || current.size + lineBytes > this.limits.maxFileBytes) {
            await this.closeSegment(dayDir, current);
            segment = undefined;
          }
        } catch { await this.closeSegment(dayDir, current); segment = undefined; }
      }
      if (!segment) segment = await this.openSegment(dayDir, date, record.source);
      if (!segment) throw new Error("log_write_failed");
      let total = await this.totalBytes();
      if (total + lineBytes > this.limits.maxTotalBytes) {
        await this.reclaimClosedSegments(total + lineBytes - this.limits.maxTotalBytes);
        total = await this.totalBytes();
      }
      if (total + lineBytes > this.limits.maxTotalBytes) throw new Error("log_write_failed");
      const filePath = path.join(dayDir, segment.name);
      const before = await lstat(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && before.uid !== process.getuid())) throw new Error("log_root_unsafe");
      const handle = await open(filePath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await handle.stat();
        if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) throw new Error("log_root_unsafe");
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        segment.size += lineBytes;
      } finally { await handle.close(); }
    });
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("log_root_unsafe");
    if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.root, ".codex-trajectory-viewer.lock");
    const start = performance.now();
    const token = randomUUID().replaceAll("-", "");
    type LockInfo = Awaited<ReturnType<typeof lstat>>;
    let lockInfo: LockInfo | undefined;

    const codeOf = (error: unknown): string | undefined =>
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    const sameFile = (left: LockInfo, right: LockInfo): boolean => left.dev === right.dev && left.ino === right.ino;
    const assertSafeLock = (info: LockInfo): void => {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("log_root_unsafe");
    };
    const sleep = (milliseconds = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const wait = async (): Promise<void> => {
      const remaining = this.lockWaitMs - (performance.now() - start);
      if (remaining <= 0) throw new Error("log_write_failed");
      await sleep(Math.min(8, remaining));
    };
    const waitForPartialLock = async (): Promise<void> => {
      if (performance.now() - start >= this.lockWaitMs) throw new Error("log_root_unsafe");
      await sleep();
    };
    const removeCreatedLock = async (createdInfo: LockInfo): Promise<void> => {
      let latest: LockInfo;
      try { latest = await lstat(lockPath); }
      catch (error) {
        if (codeOf(error) === "ENOENT") return;
        throw error;
      }
      assertSafeLock(latest);
      if (!sameFile(createdInfo, latest)) return;
      await unlink(lockPath).catch((error) => {
        if (codeOf(error) !== "ENOENT") throw error;
      });
    };
    const waitForExistingLock = async (): Promise<void> => {
      let info: LockInfo;
      try { info = await lstat(lockPath); }
      catch (error) {
        if (codeOf(error) === "ENOENT") { await wait(); return; }
        throw error;
      }
      assertSafeLock(info);

      let readHandle: Awaited<ReturnType<typeof open>>;
      try {
        readHandle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (codeOf(error) === "ENOENT") { await wait(); return; }
        if (codeOf(error) === "ELOOP") throw new Error("log_root_unsafe");
        throw error;
      }

      let openedInfo: LockInfo | undefined;
      let content: string | undefined;
      let retry = false;
      try {
        openedInfo = await readHandle.stat();
        // A lock opened just before its owner unlinks it remains a valid
        // descriptor with nlink=0. Retry acquisition after closing it.
        if (openedInfo.nlink === 0) retry = true;
        else {
          assertSafeLock(openedInfo);
          if (!sameFile(info, openedInfo)) retry = true;
          else content = await readHandle.readFile("utf8");
        }
      } catch (error) {
        if (codeOf(error) === "ENOENT") retry = true;
        else throw error;
      } finally {
        await readHandle.close();
      }
      if (retry || !openedInfo || content === undefined) { await wait(); return; }

      let latest: LockInfo;
      try { latest = await lstat(lockPath); }
      catch (error) {
        if (codeOf(error) === "ENOENT") { await wait(); return; }
        throw error;
      }
      assertSafeLock(latest);
      if (!sameFile(openedInfo, latest)) { await wait(); return; }

      let lock: { pid?: unknown; instanceId?: unknown; token?: unknown };
      try { lock = JSON.parse(content); }
      catch { await waitForPartialLock(); return; }
      if (!Number.isSafeInteger(lock.pid) || typeof lock.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(lock.instanceId) || typeof lock.token !== "string" || !/^[a-f0-9]{32}$/.test(lock.token)) {
        await waitForPartialLock();
        return;
      }

      if (!processAlive(lock.pid as number)) {
        let latestStale: LockInfo;
        try { latestStale = await lstat(lockPath); }
        catch (error) {
          if (codeOf(error) === "ENOENT") { await wait(); return; }
          throw error;
        }
        assertSafeLock(latestStale);
        if (!sameFile(openedInfo, latestStale)) { await wait(); return; }
        try { await unlink(lockPath); }
        catch (error) {
          if (codeOf(error) === "ENOENT") { await wait(); return; }
          throw error;
        }
        return;
      }

      await wait();
    };

    let creationAttempted = false;
    while (!lockInfo) {
      if (creationAttempted && performance.now() - start >= this.lockWaitMs) throw new Error("log_write_failed");
      creationAttempted = true;
      let createHandle: Awaited<ReturnType<typeof open>> | undefined;
      let createdInfo: LockInfo | undefined;
      let createError: unknown;
      try {
        createHandle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        createdInfo = await createHandle.stat();
        assertSafeLock(createdInfo);
        await createHandle.writeFile(JSON.stringify({ pid: process.pid, instanceId: this.instanceId, token }), "utf8");
        await createHandle.sync();
      } catch (error) {
        createError = error;
        if (createHandle && !createdInfo) createdInfo = await createHandle.stat().catch(() => undefined);
      } finally {
        if (createHandle) {
          await createHandle.close().catch((error) => {
            if (createError === undefined) createError = error;
          });
        }
      }

      if (createError !== undefined) {
        if (createdInfo) await removeCreatedLock(createdInfo);
        if (codeOf(createError) === "EEXIST") {
          await waitForExistingLock();
          continue;
        }
        throw createError;
      }
      if (!createdInfo) throw new Error("log_root_unsafe");
      lockInfo = createdInfo;
    }

    try { return await work(); }
    finally {
      // The lock may already have been released while this owner was closing.
      // Recheck identity and token before unlinking, with only bounded retries
      // for ENOENT from the normal release race.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let latest: LockInfo;
        try { latest = await lstat(lockPath); }
        catch (error) {
          if (codeOf(error) === "ENOENT") {
            if (attempt < 3) await sleep();
            continue;
          }
          throw error;
        }
        assertSafeLock(latest);
        if (!sameFile(lockInfo, latest)) break;

        let releaseHandle: Awaited<ReturnType<typeof open>>;
        try { releaseHandle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
        catch (error) {
          if (codeOf(error) === "ENOENT") {
            if (attempt < 3) await sleep();
            continue;
          }
          if (codeOf(error) === "ELOOP") throw new Error("log_root_unsafe");
          throw error;
        }

        let currentInfo: LockInfo | undefined;
        let content: string | undefined;
        let retryRelease = false;
        let replaced = false;
        try {
          currentInfo = await releaseHandle.stat();
          if (currentInfo.nlink === 0) replaced = true;
          else {
            assertSafeLock(currentInfo);
            if (!sameFile(lockInfo, currentInfo)) replaced = true;
            else content = await releaseHandle.readFile("utf8");
          }
        } catch (error) {
          if (codeOf(error) === "ENOENT") retryRelease = true;
          else throw error;
        } finally {
          await releaseHandle.close();
        }
        if (replaced) break;
        if (retryRelease) {
          if (attempt < 3) await sleep();
          continue;
        }
        if (!currentInfo || content === undefined) continue;

        let latestAgain: LockInfo;
        try { latestAgain = await lstat(lockPath); }
        catch (error) {
          if (codeOf(error) === "ENOENT") {
            if (attempt < 3) await sleep();
            continue;
          }
          throw error;
        }
        assertSafeLock(latestAgain);
        if (!sameFile(currentInfo, latestAgain)) break;

        let owner: { pid?: unknown; instanceId?: unknown; token?: unknown };
        try { owner = JSON.parse(content); }
        catch { throw new Error("log_root_unsafe"); }
        if (owner.pid !== process.pid || owner.instanceId !== this.instanceId || owner.token !== token) break;

        try { await unlink(lockPath); }
        catch (error) {
          if (codeOf(error) === "ENOENT") {
            if (attempt < 3) await sleep();
            continue;
          }
          throw error;
        }
        break;
      }
    }
  }

  private async openSegment(dayDir: string, date: string, source: LogSource) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const name = `${source}-${this.instanceId}-${++this.segmentSequence}.jsonl`;
      const marker = `.active-${name}`;
      const owner = `.owner-${name}`;
      const filePath = path.join(dayDir, name);
      const markerPath = path.join(dayDir, marker);
      const ownerPath = path.join(dayDir, owner);
      let file;
      try { file = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      const fileInfo = await file.stat();
      await file.close();
      const ownerToken = randomUUID().replaceAll("-", "");
      let ownerHandle: Awaited<ReturnType<typeof open>> | undefined;
      let markerHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        ownerHandle = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        await ownerHandle.writeFile(JSON.stringify({ instanceId: this.instanceId, name, token: ownerToken }), "utf8");
        await ownerHandle.sync();
        markerHandle = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        await markerHandle.writeFile(JSON.stringify({ pid: process.pid, instanceId: this.instanceId, name }), "utf8");
        await markerHandle.sync();
      } catch (error) {
        await markerHandle?.close().catch(() => undefined);
        await ownerHandle?.close().catch(() => undefined);
        const current = await lstat(filePath).catch(() => null);
        if (current?.dev === fileInfo.dev && current?.ino === fileInfo.ino && current.nlink === 1) await unlink(filePath).catch(() => undefined);
        await unlink(ownerPath).catch(() => undefined);
        throw error;
      } finally {
        await markerHandle?.close().catch(() => undefined);
        await ownerHandle?.close().catch(() => undefined);
      }
      const segment = { date, source, name, marker, owner, ownerToken, size: 0 };
      this.segments.set(`${date}/${source}`, segment);
      return segment;
    }
    throw new Error("log_write_failed");
  }

  private async closeSegment(dayDir: string, segment: { date: string; source: LogSource; name: string; size: number; marker: string; owner?: string; ownerToken?: string }): Promise<void> {
    const markerPath = path.join(dayDir, segment.marker);
    const marker = await lstat(markerPath).catch(() => null);
    if (marker?.isFile() && !marker.isSymbolicLink() && marker.nlink === 1) {
      try {
        const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let content: string;
        try { content = await handle.readFile("utf8"); } finally { await handle.close(); }
        const active = JSON.parse(content) as { pid?: unknown; instanceId?: unknown; name?: unknown };
        if (active.pid === process.pid && active.instanceId === this.instanceId && active.name === segment.name) await unlink(markerPath);
      } catch { /* Preserve markers that cannot be proved to belong to this instance. */ }
    }
    this.segments.delete(`${segment.date}/${segment.source}`);
  }

  private async listDayDirectories(): Promise<Array<{ name: string; path: string }>> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: path.join(this.root, entry.name) }));
  }

  private async cleanOld(today: string): Promise<void> {
    const cutoff = calendarCutoff(new Date(`${today}T12:00:00`), this.limits.retentionDays);
    for (const day of await this.listDayDirectories()) {
      const entries = await readdir(day.path, { withFileTypes: true });
      for (const entry of entries) {
        const markerMatch = entry.name.match(/^\.active-(server|http|browser)-([a-f0-9]{32})-(\d+)\.jsonl$/);
        if (markerMatch && entry.isFile() && !entry.isSymbolicLink()) {
          const markerPath = path.join(day.path, entry.name);
          const info = await lstat(markerPath);
          if (info.nlink !== 1) continue;
          let marker: { pid?: unknown; instanceId?: unknown; name?: unknown };
          try {
            const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let content: string;
            try { content = await handle.readFile("utf8"); } finally { await handle.close(); }
            marker = JSON.parse(content);
          }
          catch { continue; }
          if (marker.name !== entry.name.slice(".active-".length) || marker.instanceId !== markerMatch[2] || !Number.isSafeInteger(marker.pid)) continue;
          if (!processAlive(marker.pid as number)) await unlink(markerPath);
        }
      }
      if (day.name >= cutoff) continue;
      for (const entry of entries) {
        const logMatch = entry.name.match(/^(server|http|browser)-([a-f0-9]{32})-(\d+)\.jsonl$/);
        if (!logMatch || !entry.isFile() || entry.isSymbolicLink()) continue;
        const filePath = path.join(day.path, entry.name);
        const info = await lstat(filePath);
        if (!info.isFile() || info.nlink !== 1 || (typeof process.getuid === "function" && info.uid !== process.getuid())) continue;
        const active = await lstat(path.join(day.path, `.active-${entry.name}`)).catch(() => null);
        if (active) continue;
        if (!await this.hasOwnerMetadata(day.path, entry.name)) continue;
        await unlink(filePath);
        await unlink(path.join(day.path, `.owner-${entry.name}`)).catch(() => undefined);
      }
    }
  }

  private async hasOwnerMetadata(dayDir: string, name: string): Promise<boolean> {
    const ownerPath = path.join(dayDir, `.owner-${name}`);
    const info = await lstat(ownerPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && info.uid !== process.getuid())) return false;
    try {
      const handle = await open(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: string;
      try { content = await handle.readFile("utf8"); } finally { await handle.close(); }
      const owner = JSON.parse(content) as { instanceId?: unknown; name?: unknown; token?: unknown };
      return typeof owner.instanceId === "string" && /^[a-f0-9]{32}$/.test(owner.instanceId)
        && owner.name === name && typeof owner.token === "string" && /^[a-f0-9]{32}$/.test(owner.token);
    } catch { return false; }
  }

  private async reclaimClosedSegments(bytesNeeded: number): Promise<void> {
    if (bytesNeeded <= 0) return;
    const candidates: Array<{ path: string; date: string; name: string; size: number; modified: number }> = [];
    for (const day of await this.listDayDirectories()) {
      for (const entry of await readdir(day.path, { withFileTypes: true })) {
        if (!/^(server|http|browser)-[a-f0-9]{32}-\d+\.jsonl$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
        const filePath = path.join(day.path, entry.name);
        const info = await lstat(filePath);
        if (!info.isFile() || info.nlink !== 1 || (typeof process.getuid === "function" && info.uid !== process.getuid())) continue;
        if (await lstat(path.join(day.path, `.active-${entry.name}`)).catch(() => null)) continue;
        if (!await this.hasOwnerMetadata(day.path, entry.name)) continue;
        candidates.push({ path: filePath, date: day.name, name: entry.name, size: info.size, modified: info.mtimeMs });
      }
    }
    candidates.sort((left, right) => left.date.localeCompare(right.date) || left.modified - right.modified || left.name.localeCompare(right.name));
    let reclaimed = 0;
    for (const candidate of candidates) {
      if (reclaimed >= bytesNeeded) break;
      const directory = path.dirname(candidate.path);
      if (await lstat(path.join(directory, `.active-${candidate.name}`)).catch(() => null)) continue;
      const latest = await lstat(candidate.path).catch(() => null);
      if (!latest?.isFile() || latest.nlink !== 1 || (typeof process.getuid === "function" && latest.uid !== process.getuid())) continue;
      await unlink(candidate.path);
      await unlink(path.join(directory, `.owner-${candidate.name}`)).catch(() => undefined);
      reclaimed += latest.size;
    }
  }

  private async totalBytes(): Promise<number> {
    let total = 0;
    const directories = await readdir(this.root, { withFileTypes: true });
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const info = await lstat(path.join(this.root, entry.name));
        if (info.isFile() && info.nlink === 1) total += info.size;
        continue;
      }
      const dayPath = path.join(this.root, entry.name);
      for (const child of await readdir(dayPath, { withFileTypes: true })) {
        if (!child.isFile() || child.isSymbolicLink()) continue;
        const info = await lstat(path.join(dayPath, child.name));
        if (info.isFile() && info.nlink === 1) total += info.size;
      }
    }
    return total;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.withLock(async () => {
      for (const segment of [...this.segments.values()]) await this.closeSegment(path.join(this.root, segment.date), segment).catch(() => undefined);
    }).catch(() => undefined);
  }
}

type AppLoggerOptions = {
  sink: LoggerSink;
  minLevel?: LogLevel;
  clock?: () => Date;
  instanceId?: string;
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  closeTimeoutMs?: number;
  stderr?: (message: string) => void;
  monotonicNow?: () => number;
};

export function createAppLogger(options: AppLoggerOptions): AppLogger {
  const minimumLevel = options.minLevel ?? "info";
  const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const clock = options.clock ?? (() => new Date());
  const instanceId = options.instanceId ?? randomUUID().replaceAll("-", "");
  const maxQueueEvents = options.maxQueueEvents ?? DEFAULT_LOG_LIMITS.maxQueueEvents;
  const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_LOG_LIMITS.maxQueueBytes;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const stderr = options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  const queue: Array<{ record: SafeLogRecord; serialized: string; bytes: number; resolve: (success: boolean) => void }> = [];
  const seenEvents = new Map<string, { expires: number; completed: boolean }>();
  const rateWindows = new Map<string, { start: number; count: number }>();
  const sourceStates = new Map<string, string>();
  let queueBytes = 0;
  let seq = 0;
  let dropped = 0;
  let activeDrain: Promise<void> | null = null;
  let closed = false;
  let closing = false;
  let healthy = true;
  let lastErrorCode: string | null = null;
  let lastStderrAt = -Infinity;

  function writeStderr(code: string): void {
    const now = monotonicNow();
    if (now - lastStderrAt < 30_000) return;
    lastStderrAt = now;
    try { stderr(`[codex-trajectory-viewer] logging degraded (${code}); browsing continues`); } catch { /* stderr may be unavailable */ }
  }

  async function drain(): Promise<void> {
    if (activeDrain) return activeDrain;
    activeDrain = (async () => {
      while (queue.length) {
        const item = queue.shift()!;
        queueBytes -= item.bytes;
        try {
          await options.sink.write(item.record, item.serialized);
          item.resolve(true);
          if (!healthy && !closed) {
            healthy = true;
            lastErrorCode = null;
            enqueue("logger_drop_summary", { dropped_count: dropped, queued_count: queue.length });
          }
        } catch (error) {
          item.resolve(false);
          healthy = false;
          const code = error instanceof Error && error.message === "log_root_unsafe" ? "log_root_unsafe" : "log_write_failed";
          lastErrorCode = code;
          dropped += 1;
          writeStderr(code);
        }
      }
    })().finally(() => { activeDrain = null; if (queue.length && !closed) void drain(); });
    return activeDrain;
  }

  function enqueue(event: string, fields: Record<string, unknown> = {}, context: LoggerContext = {}): Promise<boolean> {
    if (closed || closing) return Promise.resolve(false);
    const safe = sanitizeRecord(event, fields, context);
    if (!safe) return Promise.resolve(false);
    if (severity[safe.level] < severity[minimumLevel]) return Promise.resolve(true);
    const date = clock();
    const record: SafeLogRecord = {
      ...safe,
      schema_version: LOG_SCHEMA_VERSION,
      time: localTimestamp(date),
      instance_id: instanceId,
      seq: ++seq,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    while (queue.length >= maxQueueEvents || queueBytes + bytes > maxQueueBytes) {
      const low = queue.findIndex((item) => item.record.level === "debug" || item.record.level === "info");
      if (low < 0 || (record.level !== "warn" && record.level !== "error")) {
        dropped += 1;
        healthy = false;
        lastErrorCode = "queue_full";
        writeStderr("queue_full");
        return Promise.resolve(false);
      }
      const [removed] = queue.splice(low, 1);
      queueBytes -= removed.bytes;
      removed.resolve(false);
      dropped += 1;
      healthy = false;
      lastErrorCode = "queue_full";
      writeStderr("queue_full");
    }
    const completion = new Promise<boolean>((resolve) => queue.push({ record, serialized, bytes, resolve }));
    queueBytes += bytes;
    void drain();
    return completion;
  }

  function rateAllows(clientId: string, count: number): boolean {
    const now = monotonicNow();
    if (rateWindows.size > 2048) {
      for (const [key, window] of rateWindows) if (now - window.start >= 60_000) rateWindows.delete(key);
      if (rateWindows.size > 2048 && !rateWindows.has(clientId)) return false;
    }
    const total = rateWindows.get("*") ?? { start: now, count: 0 };
    if (now - total.start >= 60_000) { total.start = now; total.count = 0; }
    const client = rateWindows.get(clientId) ?? { start: now, count: 0 };
    if (now - client.start >= 60_000) { client.start = now; client.count = 0; }
    if (total.count + count > 3000 || client.count + count > 300) return false;
    total.count += count;
    client.count += count;
    rateWindows.set("*", total);
    rateWindows.set(clientId, client);
    return true;
  }

  return {
    emit(event, fields, context) { void enqueue(event, fields, context); },
    async acceptBrowserBatch(events) {
      const now = monotonicNow();
      for (const [key, seen] of seenEvents) if (seen.expires <= now) seenEvents.delete(key);
      let accepted = 0;
      let duplicate = 0;
      let rejected = 0;
      const pending: Array<{ key: string; promise: Promise<boolean> }> = [];
      for (const raw of events.slice(0, 50)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { rejected += 1; continue; }
        const input = raw as Record<string, unknown>;
        const clientId = input.client_id;
        const eventId = input.event_id;
        const event = typeof input.event === "string" ? input.event : "";
        const spec = SPECS[event];
        if (!safeId(clientId) || !safeId(eventId) || !spec || spec.source !== "browser" || !validBrowserInput(input, event)) { rejected += 1; continue; }
        const key = `${clientId}:${eventId}`;
        const previous = seenEvents.get(key);
        if (previous?.completed) { duplicate += 1; continue; }
        if (previous) { rejected += 1; continue; }
        if (seenEvents.size >= 4096) {
          const evictable = [...seenEvents].find(([, seen]) => seen.completed)?.[0];
          if (!evictable) { rejected += 1; continue; }
          seenEvents.delete(evictable);
        }
        if (!rateAllows(clientId, 1)) { rejected += 1; continue; }
        seenEvents.set(key, { expires: now + 10 * 60_000, completed: false });
        const context = {
          operation_id: safeId(input.operation_id) ? input.operation_id : undefined,
          request_id: safeId(input.request_id) ? input.request_id : undefined,
          client_id: clientId,
          tab_id: safeId(input.tab_id) ? input.tab_id : undefined,
          client_time: safeTime(input.client_time) ? input.client_time : undefined,
          client_seq: safeNumber(input.client_seq),
          event_id: eventId,
        };
        const promise = enqueue(event, input, context);
        pending.push({ key, promise });
      }
      const settled = await Promise.all(pending.map(({ key, promise }) => promise.then((success) => ({ key, success }))));
      for (const item of settled) {
        if (item.success) {
          accepted += 1;
          const seen = seenEvents.get(item.key);
          if (seen) seen.completed = true;
        }
        else { rejected += 1; seenEvents.delete(item.key); }
      }
      return { accepted, duplicate, rejected };
    },
    sourceState(database, state, code) {
      if (!ENUMS.database.includes(database)) return;
      const normalizedCode = safeEnum("error_code", code) ?? "sqlite_unavailable";
      const key = `${database}:${state}:${normalizedCode}`;
      if (sourceStates.get(database) === key) return;
      const previous = sourceStates.get(database);
      sourceStates.set(database, key);
      const actualState = state === "available" && previous ? "recovered" : state;
      const event = actualState === "degraded" || actualState === "error" ? "sqlite_source_warning" : "sqlite_source_state";
      void enqueue(event, { database, state: actualState, error_code: actualState === "available" || actualState === "recovered" ? undefined : normalizedCode });
    },
    status() { return { healthy, queued: queue.length, dropped, lastErrorCode }; },
    async close(timeoutMs = options.closeTimeoutMs ?? DEFAULT_LOG_LIMITS.closeTimeoutMs) {
      if (closed || closing) return;
      closing = true;
      const draining = drain();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        draining.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); }),
      ]);
      if (timer) clearTimeout(timer);
      closed = true;
      if (queue.length) { dropped += queue.length; for (const item of queue) item.resolve(false); queue.length = 0; queueBytes = 0; }
      const closeSink = async () => {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.resolve(options.sink.close?.()).catch(() => undefined),
          new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
        ]);
        if (closeTimer) clearTimeout(closeTimer);
      };
      if (completed) await closeSink();
      else void draining.finally(closeSink);
    },
  };
}

export function createFileLogger(options: FileLogOptions = {}): AppLogger {
  const limits = { ...DEFAULT_LOG_LIMITS, ...options.limits };
  const sink = new FileLogSink({ ...options, limits });
  return createAppLogger({ sink, minLevel: options.minLevel, clock: options.clock, instanceId: sink.instanceId, maxQueueEvents: limits.maxQueueEvents, maxQueueBytes: limits.maxQueueBytes, closeTimeoutMs: limits.closeTimeoutMs });
}

export function classifySafeError(error: unknown): { error_type: string; error_code: string; stack: Array<{ module: StackModule; line: number; column: number }> } {
  let type = error instanceof Error && ENUMS.error_type.includes(error.name) ? error.name : "UnknownError";
  if (error instanceof Error && error.name === "AbortError") type = "AbortError";
  return { error_type: type, error_code: type === "AbortError" ? "aborted" : "internal_error", stack: stackFrames(error) };
}

export function routeForRequest(pathname: string, view: string | null, method: string): string {
  if (pathname === "/api/logs") return "logs_ingest";
  if (method !== "GET") return "method_not_allowed";
  if (pathname === "/api/sessions") return "sessions_list";
  if (pathname.startsWith("/api/sessions/")) {
    if (view === "window" || view === "page" || view === "raw" || view === "download" || view === "search" || view === "history" || view === "history-search") return `sessions_${view.replace("-", "_")}`;
    return "sessions_detail";
  }
  if (pathname.startsWith("/api/")) return "unknown_api";
  return "static";
}

export async function readJsonBody(request: AsyncIterable<Uint8Array> & { iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>; resume?: () => void }, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = typeof request.iterator === "function" ? request.iterator({ destroyOnReturn: false }) : request[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = next.value;
    size += chunk.byteLength;
    if (size > maxBytes) {
      request.resume?.();
      throw Object.assign(new Error("payload_too_large"), { code: "payload_too_large" });
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid_json"), { code: "invalid_json" }); }
}

export function isAllowedLogOrigin(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const rawOrigin = request.headers.origin;
  const rawHost = request.headers.host;
  if (typeof rawOrigin !== "string" || typeof rawHost !== "string" || rawOrigin.length > 255 || rawHost.length > 255) return false;
  try {
    const origin = new URL(rawOrigin);
    const host = new URL(`http://${rawHost}`);
    const hostname = host.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const originHostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const originLocal = originHostname === "localhost" || originHostname === "127.0.0.1" || originHostname === "::1";
    return local && originLocal && origin.protocol === "http:" && origin.origin === rawOrigin && origin.host.toLowerCase() === rawHost.toLowerCase();
  } catch { return false; }
}
