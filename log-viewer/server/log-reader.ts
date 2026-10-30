import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, LogFile, LogFileDescriptor, LogLevel, LogList, LogPage, LogSource, RevisionPayload } from "./types.js";

const SOURCES = new Set<LogSource>(["server", "http", "browser"]);
const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const DATE_NAME = /^\d{4}-\d{2}-\d{2}$/;
const LOG_NAME = /^(server|http|browser)-([a-f0-9]{32})-(\d+)\.jsonl$/;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const MAX_LINE_BYTES = 64 * 1024;
// The logger rotates at 10 MiB. Keep the reader bounded if a file was replaced
// or edited outside the logger's normal rotation policy.
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_ENTRIES = 20_000;
const REVISION_SECRET = randomBytes(32);

export class LogReadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = "LogReadError";
    this.status = status;
    this.code = code;
  }
}

interface RootContext {
  path: string;
  dev: string;
  ino: string;
}

interface OpenSnapshot {
  handle: FileHandle;
  size: number;
  mtime: string;
  dev: string;
  ino: string;
  nlink: number;
}

interface Filters {
  level?: LogLevel;
  source?: LogSource;
  q?: string;
  operationId?: string;
  requestId?: string;
}

interface PageSelection {
  limit: number;
  afterLine: number;
  lastPage: boolean;
}

interface ScannedFile {
  totalLines: number;
  wholeHash: string;
  prefixHash: string;
  matchedLines: number;
  entries: LogEntry[];
  hasMore: boolean;
  nextAfterLine: number;
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | NO_FOLLOW;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LogReadError(499, "aborted", "The log request was cancelled.");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeId(date: string, name: string): string {
  return createHash("sha256").update(date).update("\0").update(name).digest("base64url");
}

function signRevision(payload: RevisionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", REVISION_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function decodeRevision(value: string): RevisionPayload {
  if (value.length > 2048) throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  const pieces = value.split(".");
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]) || !/^[A-Za-z0-9_-]+$/.test(pieces[1])) {
    throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  }

  const expected = createHmac("sha256", REVISION_SECRET).update(pieces[0]).digest();
  const actual = Buffer.from(pieces[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
  } catch {
    throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  }
  if (!payload || typeof payload !== "object") throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  const candidate = payload as Partial<RevisionPayload>;
  if (candidate.version !== 1 || typeof candidate.id !== "string" || typeof candidate.dev !== "string"
    || typeof candidate.ino !== "string" || !Number.isSafeInteger(candidate.size) || Number(candidate.size) < 0
    || typeof candidate.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.prefixHash)) {
    throw new LogReadError(400, "invalid_revision", "The revision is invalid.");
  }
  return candidate as RevisionPayload;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validCalendarDate(value: string): boolean {
  if (!DATE_NAME.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function realRoot(logRoot: string): Promise<RootContext> {
  if (typeof logRoot !== "string" || logRoot.length === 0 || !path.isAbsolute(logRoot)) {
    throw new LogReadError(503, "log_root_unavailable", "The configured log root is unavailable.");
  }
  try {
    const canonical = await realpath(logRoot);
    const stats = await lstat(canonical, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a directory");
    return { path: canonical, dev: String(stats.dev), ino: String(stats.ino) };
  } catch {
    throw new LogReadError(503, "log_root_unavailable", "The configured log root is unavailable.");
  }
}

async function checkRootStillMatches(root: RootContext): Promise<void> {
  try {
    const currentPath = await realpath(root.path);
    const current = await lstat(currentPath, { bigint: true });
    if (currentPath !== root.path || !current.isDirectory() || String(current.dev) !== root.dev || String(current.ino) !== root.ino) {
      throw new Error("root changed");
    }
  } catch {
    throw new LogReadError(409, "stale_revision", "The log root changed while it was being read.");
  }
}

function parseName(name: string): { source: LogSource; instanceId: string; segment: number } | null {
  const match = LOG_NAME.exec(name);
  if (!match) return null;
  const segment = Number(match[3]);
  if (!Number.isSafeInteger(segment) || segment < 1) return null;
  const source = match[1] as LogSource;
  if (!SOURCES.has(source)) return null;
  return { source, instanceId: match[2], segment };
}

function toPublic(file: LogFileDescriptor): LogFile {
  return {
    id: file.id,
    date: file.date,
    source: file.source,
    instanceId: file.instanceId,
    segment: file.segment,
    name: file.name,
    size: file.size,
    modifiedAt: file.modifiedAt,
  };
}

function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function safeDirectory(root: RootContext, date: string): Promise<{ path: string; dev: string; ino: string } | null> {
  const candidate = path.join(root.path, date);
  try {
    const info = await lstat(candidate, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const canonical = await realpath(candidate);
    if (canonical !== candidate || !isWithin(root.path, canonical)) return null;
    return { path: canonical, dev: String(info.dev), ino: String(info.ino) };
  } catch {
    return null;
  }
}

async function safeDescriptor(root: RootContext, date: string, directory: { path: string; dev: string; ino: string }, name: string): Promise<LogFileDescriptor | null> {
  const parsed = parseName(name);
  if (!parsed) return null;
  const filePath = path.join(directory.path, name);
  try {
    const info = await lstat(filePath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return null;
    const canonical = await realpath(filePath);
    if (canonical !== filePath || !isWithin(root.path, canonical) || path.dirname(canonical) !== directory.path) return null;
    const size = Number(info.size);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    return {
      id: makeId(date, name),
      date,
      source: parsed.source,
      instanceId: parsed.instanceId,
      segment: parsed.segment,
      name,
      size,
      modifiedAt: new Date(Number(info.mtimeNs) / 1_000_000).toISOString(),
      filePath,
      datePath: directory.path,
      dateDev: directory.dev,
      dateIno: directory.ino,
      dev: String(info.dev),
      ino: String(info.ino),
    };
  } catch {
    return null;
  }
}

async function discoverDescriptors(logRoot: string): Promise<{ root: RootContext; files: LogFileDescriptor[]; warnings: number }> {
  const root = await realRoot(logRoot);
  let warnings = 0;
  const files: LogFileDescriptor[] = [];
  let scannedEntries = 0;
  const countEntry = (): void => {
    scannedEntries += 1;
    if (scannedEntries > MAX_SCAN_ENTRIES) {
      throw new LogReadError(503, "scan_limit", `The log directory contains more than ${MAX_SCAN_ENTRIES} entries.`);
    }
  };

  let rootDirectory;
  try {
    rootDirectory = await opendir(root.path);
  } catch {
    throw new LogReadError(503, "log_root_unavailable", "The configured log root cannot be read.");
  }

  for await (const entry of rootDirectory) {
    countEntry();
    if (!validCalendarDate(entry.name)) continue;
    const directory = await safeDirectory(root, entry.name);
    if (!directory) {
      warnings += 1;
      continue;
    }
    let childDirectory;
    try {
      childDirectory = await opendir(directory.path);
    } catch {
      warnings += 1;
      continue;
    }
    for await (const child of childDirectory) {
      countEntry();
      if (!LOG_NAME.test(child.name)) continue;
      const descriptor = await safeDescriptor(root, entry.name, directory, child.name);
      if (descriptor) files.push(descriptor);
      else warnings += 1;
    }
  }

  await checkRootStillMatches(root);
  files.sort((a, b) => b.date.localeCompare(a.date)
    || a.source.localeCompare(b.source)
    || a.instanceId.localeCompare(b.instanceId)
    || a.segment - b.segment);
  return { root, files, warnings };
}

/** Discover only valid dated log segments. Sidecars and unknown files are ignored. */
export async function discoverLogs(logRoot: string): Promise<LogList> {
  try {
    const discovered = await discoverDescriptors(logRoot);
    return { files: discovered.files.map(toPublic), warnings: discovered.warnings };
  } catch (error) {
    if (error instanceof LogReadError && error.code === "log_root_unavailable") return { files: [], warnings: 1 };
    throw error;
  }
}

async function openVerifiedFile(root: RootContext, descriptor: LogFileDescriptor): Promise<OpenSnapshot> {
  if (!isWithin(root.path, descriptor.filePath) || path.dirname(descriptor.filePath) !== descriptor.datePath) {
    throw new LogReadError(404, "log_not_found", "The requested log file is unavailable.");
  }

  await checkRootStillMatches(root);
  try {
    const directory = await lstat(descriptor.datePath, { bigint: true });
    const canonicalDirectory = await realpath(descriptor.datePath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || canonicalDirectory !== descriptor.datePath
      || String(directory.dev) !== descriptor.dateDev || String(directory.ino) !== descriptor.dateIno
      || !isWithin(root.path, canonicalDirectory)) {
      throw new LogReadError(409, "stale_revision", "The log directory changed while it was being opened.");
    }
  } catch (error) {
    if (error instanceof LogReadError) throw error;
    throw new LogReadError(409, "stale_revision", "The log directory changed while it was being opened.");
  }

  let handle: FileHandle;
  try {
    handle = await open(descriptor.filePath, READ_ONLY_NO_FOLLOW);
  } catch {
    throw new LogReadError(409, "stale_revision", "The log file changed while it was being opened.");
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n || String(stats.dev) !== descriptor.dev || String(stats.ino) !== descriptor.ino) {
      throw new LogReadError(409, "stale_revision", "The log file changed while it was being opened.");
    }
    const pathInfo = await lstat(descriptor.filePath, { bigint: true });
    const canonical = await realpath(descriptor.filePath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n || !sameIdentity(pathInfo, stats)
      || canonical !== descriptor.filePath || !isWithin(root.path, canonical)) {
      throw new LogReadError(409, "stale_revision", "The log file changed while it was being opened.");
    }
    await checkRootStillMatches(root);

    const size = Number(stats.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new LogReadError(413, "log_too_large", "The log file is too large to read safely.");
    if (size > MAX_LOG_BYTES) throw new LogReadError(413, "log_too_large", "The log file is too large to read safely.");
    return {
      handle,
      size,
      mtime: new Date(Number(stats.mtimeNs) / 1_000_000).toISOString(),
      dev: String(stats.dev),
      ino: String(stats.ino),
      nlink: Number(stats.nlink),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof LogReadError) throw error;
    throw new LogReadError(409, "stale_revision", "The log file changed while it was being opened.");
  }
}

async function findCurrentDescriptor(logRoot: string, id: string): Promise<{ root: RootContext; file: LogFileDescriptor }> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(id)) {
    throw new LogReadError(404, "log_not_found", "The requested log file was not found.");
  }
  const discovered = await discoverDescriptors(logRoot);
  const file = discovered.files.find((candidate) => candidate.id === id);
  if (!file) throw new LogReadError(404, "log_not_found", "The requested log file was not found.");
  return { root: discovered.root, file };
}

function parseBoundedString(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (value.length > 256) throw new LogReadError(400, "invalid_query", `The ${name} filter is too long.`);
  return value;
}

function parseFilters(params: URLSearchParams): Filters {
  const levelValue = parseBoundedString(params, "level");
  const sourceValue = parseBoundedString(params, "source");
  if (levelValue && !LEVELS.has(levelValue as LogLevel)) throw new LogReadError(400, "invalid_query", "The level filter is invalid.");
  if (sourceValue && !SOURCES.has(sourceValue as LogSource)) throw new LogReadError(400, "invalid_query", "The source filter is invalid.");
  return {
    ...(levelValue ? { level: levelValue as LogLevel } : {}),
    ...(sourceValue ? { source: sourceValue as LogSource } : {}),
    ...(parseBoundedString(params, "q") !== undefined ? { q: parseBoundedString(params, "q")! } : {}),
    ...(parseBoundedString(params, "operationId") !== undefined ? { operationId: parseBoundedString(params, "operationId")! } : {}),
    ...(parseBoundedString(params, "requestId") !== undefined ? { requestId: parseBoundedString(params, "requestId")! } : {}),
  };
}

function parsePositiveInteger(value: string, name: string, allowZero = false): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new LogReadError(400, "invalid_query", `The ${name} value is invalid.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!allowZero && number < 1)) throw new LogReadError(400, "invalid_query", `The ${name} value is invalid.`);
  return number;
}

function parsePageSelection(params: URLSearchParams): PageSelection {
  const limitValue = params.get("limit");
  const limit = limitValue === null ? DEFAULT_PAGE_SIZE : parsePositiveInteger(limitValue, "limit");
  if (limit > MAX_PAGE_SIZE) throw new LogReadError(400, "invalid_query", `The limit cannot exceed ${MAX_PAGE_SIZE}.`);

  const lineValue = params.get("line");
  if (lineValue === "last") return { limit, afterLine: 0, lastPage: true };
  if (lineValue !== null) return { limit, afterLine: parsePositiveInteger(lineValue, "line") - 1, lastPage: false };

  const afterLineValue = params.get("afterLine");
  const afterLine = afterLineValue === null ? 0 : parsePositiveInteger(afterLineValue, "afterLine", true);
  return { limit, afterLine, lastPage: false };
}

function recordForLine(buffer: Buffer, byteLength: number, truncated: boolean): Pick<LogEntry, "raw" | "record" | "error"> {
  const raw = buffer.subarray(0, byteLength).toString("utf8");
  if (truncated) return { raw, record: null, error: "line_too_large" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { raw, record: null, error: "invalid_record" };
    return { raw, record: parsed as Record<string, unknown>, error: null };
  } catch {
    return { raw, record: null, error: "invalid_json" };
  }
}

function lineMatches(entry: LogEntry, filters: Filters, qMatched: boolean): boolean {
  if (filters.q !== undefined && !qMatched) return false;
  if (!filters.level && !filters.source && !filters.operationId && !filters.requestId) return true;
  const record = entry.record;
  if (!record) return false;
  if (filters.level !== undefined && record.level !== filters.level) return false;
  if (filters.source !== undefined && record.source !== filters.source) return false;
  if (filters.operationId !== undefined && record.operation_id !== filters.operationId) return false;
  if (filters.requestId !== undefined && record.request_id !== filters.requestId) return false;
  return true;
}

interface SearchState {
  needle: Buffer | null;
  tail: Buffer;
  matched: boolean;
}

function searchSegment(state: SearchState, segment: Buffer): void {
  const needle = state.needle;
  if (!needle || state.matched) return;
  const combined = state.tail.length ? Buffer.concat([state.tail, segment]) : segment;
  if (combined.indexOf(needle) >= 0) {
    state.matched = true;
    return;
  }
  state.tail = combined.subarray(Math.max(0, combined.length - needle.length + 1));
}

async function hashRange(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    throwIfAborted(signal);
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new LogReadError(409, "stale_revision", "The log file changed while it was being read.");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  throwIfAborted(signal);
  return hash.digest("hex");
}

async function scanFile(handle: FileHandle, size: number, prefixSize: number, filters: Filters, selection: PageSelection, signal?: AbortSignal): Promise<ScannedFile> {
  const wholeHash = createHash("sha256");
  const prefixHash = createHash("sha256");
  const needle = filters.q === undefined || filters.q.length === 0 ? null : Buffer.from(filters.q, "utf8");
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const rowBuffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
  const stored: LogEntry[] = [];
  const search: SearchState = { needle, tail: Buffer.alloc(0), matched: needle === null };
  let position = 0;
  let rowLength = 0;
  let rowTruncated = false;
  let totalLines = 0;
  let matchedLines = 0;
  let hasMore = false;

  const addToRow = (segment: Buffer): void => {
    if (!segment.length) return;
    searchSegment(search, segment);
    const copyLength = Math.min(segment.length, MAX_LINE_BYTES - rowLength);
    if (copyLength > 0) {
      segment.copy(rowBuffer, rowLength, 0, copyLength);
      rowLength += copyLength;
    }
    if (copyLength < segment.length) rowTruncated = true;
  };

  const resetRow = (): void => {
    rowLength = 0;
    rowTruncated = false;
    search.tail = Buffer.alloc(0);
    search.matched = needle === null;
  };

  const consumeRow = (): void => {
    totalLines += 1;
    const parsed = recordForLine(rowBuffer, rowLength, rowTruncated);
    const entry: LogEntry = { line: totalLines, ...parsed, truncated: rowTruncated };
    if (lineMatches(entry, filters, search.matched)) {
      matchedLines += 1;
      if (selection.lastPage) {
        stored.push(entry);
        if (stored.length > selection.limit) stored.shift();
      } else if (entry.line > selection.afterLine) {
        if (stored.length < selection.limit) stored.push(entry);
        else hasMore = true;
      }
    }
    resetRow();
  };

  while (position < size) {
    throwIfAborted(signal);
    const length = Math.min(chunk.length, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) throw new LogReadError(409, "stale_revision", "The log file changed while it was being read.");
    const bytes = chunk.subarray(0, bytesRead);
    wholeHash.update(bytes);
    if (position < prefixSize) prefixHash.update(bytes.subarray(0, Math.min(bytesRead, prefixSize - position)));

    let start = 0;
    while (start < bytesRead) {
      throwIfAborted(signal);
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) {
        addToRow(bytes.subarray(start, bytesRead));
        break;
      }
      addToRow(bytes.subarray(start, newline));
      consumeRow();
      start = newline + 1;
    }
    position += bytesRead;
  }

  throwIfAborted(signal);
  // A trailing newline ends the last record; it does not introduce another one.
  if (rowLength > 0 || rowTruncated) consumeRow();

  return {
    totalLines,
    wholeHash: wholeHash.digest("hex"),
    prefixHash: prefixHash.digest("hex"),
    matchedLines,
    entries: stored,
    hasMore: selection.lastPage ? false : hasMore,
    nextAfterLine: stored.length > 0 ? stored[stored.length - 1].line : selection.afterLine,
  };
}

async function verifyStillCurrent(root: RootContext, descriptor: LogFileDescriptor, handle: FileHandle, expectedSize: number): Promise<void> {
  await checkRootStillMatches(root);
  const [handleStats, pathStats, canonical] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(descriptor.filePath, { bigint: true }),
    realpath(descriptor.filePath),
  ]).catch(() => {
    throw new LogReadError(409, "stale_revision", "The log file changed while it was being read.");
  });
  const unchangedPath = pathStats.isFile() && !pathStats.isSymbolicLink() && pathStats.nlink === 1n
    && sameIdentity(pathStats, handleStats) && canonical === descriptor.filePath && path.dirname(canonical) === descriptor.datePath
    && isWithin(root.path, canonical);
  if (!handleStats.isFile() || handleStats.nlink !== 1n || !unchangedPath || Number(handleStats.size) < expectedSize) {
    throw new LogReadError(409, "stale_revision", "The log file changed while it was being read.");
  }
}

async function validatePriorRevision(handle: FileHandle, opened: OpenSnapshot, id: string, revision: string | undefined, signal?: AbortSignal): Promise<RevisionPayload | null> {
  if (revision === undefined) return null;
  const prior = decodeRevision(revision);
  if (prior.id !== id || prior.dev !== opened.dev || prior.ino !== opened.ino || opened.size < prior.size) {
    throw new LogReadError(409, "stale_revision", "The log file changed since the requested revision.");
  }
  const actualPrefix = await hashRange(handle, prior.size, signal);
  if (actualPrefix !== prior.prefixHash) throw new LogReadError(409, "stale_revision", "The log file changed since the requested revision.");
  return prior;
}

/** Read one bounded page. Reads are snapshots up to the file size seen at open. */
export async function readLogPage(logRoot: string, id: string, params: URLSearchParams, signal?: AbortSignal): Promise<LogPage> {
  throwIfAborted(signal);
  const filters = parseFilters(params);
  const selection = parsePageSelection(params);
  const revisionValue = params.get("revision") ?? undefined;
  const { root, file } = await findCurrentDescriptor(logRoot, id);
  const opened = await openVerifiedFile(root, file);
  try {
    const prior = await validatePriorRevision(opened.handle, opened, id, revisionValue, signal);
    const snapshotSize = prior?.size ?? opened.size;
    const scanned = await scanFile(opened.handle, snapshotSize, snapshotSize, filters, selection, signal);
    // Recheck the content we just rendered. This allows pure appends but catches
    // in-place rewrites while a page is being assembled.
    if (await hashRange(opened.handle, snapshotSize, signal) !== scanned.wholeHash) {
      throw new LogReadError(409, "stale_revision", "The log file changed while it was being read.");
    }
    throwIfAborted(signal);
    await verifyStillCurrent(root, file, opened.handle, snapshotSize);
    const freshRevision = signRevision({
      version: 1,
      id,
      dev: opened.dev,
      ino: opened.ino,
      size: snapshotSize,
      prefixHash: scanned.wholeHash,
    });
    return {
      file: { ...toPublic(file), size: snapshotSize, modifiedAt: opened.mtime },
      revision: freshRevision,
      totalLines: scanned.totalLines,
      matchedLines: scanned.matchedLines,
      entries: scanned.entries,
      hasMore: scanned.hasMore,
      nextAfterLine: scanned.nextAfterLine,
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Open the exact safe file handle after validating its signed revision. The
 * returned size is the immutable byte boundary the caller must stream to.
 */
export async function openLogDownload(logRoot: string, id: string, revision: string, signal?: AbortSignal): Promise<{ file: LogFile; handle: FileHandle; size: number }> {
  throwIfAborted(signal);
  const { root, file } = await findCurrentDescriptor(logRoot, id);
  const opened = await openVerifiedFile(root, file);
  try {
    const prior = await validatePriorRevision(opened.handle, opened, id, revision, signal);
    const snapshotSize = prior?.size ?? opened.size;
    const snapshotHash = await hashRange(opened.handle, snapshotSize, signal);
    if (await hashRange(opened.handle, snapshotSize, signal) !== snapshotHash) {
      throw new LogReadError(409, "stale_revision", "The log file changed while it was being opened for download.");
    }
    throwIfAborted(signal);
    await verifyStillCurrent(root, file, opened.handle, snapshotSize);
    return {
      file: { ...toPublic(file), size: snapshotSize, modifiedAt: opened.mtime },
      handle: opened.handle,
      size: snapshotSize,
    };
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    throw error;
  }
}
