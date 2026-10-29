import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { subagentActivityFromRollout } from "./subagents.js";
import type { SubagentActivity } from "./types.js";

export const ROLLOUT_PAGE_SIZE = 32;
export const ROLLOUT_MAX_LINE_BYTES = 64 * 1024;
export const ROLLOUT_MAX_RAW_CHUNK_BYTES = 16 * 1024;
export const ROLLOUT_INDEX_CACHE_MAX_FILES = 16;
export const ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES = 8 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;
const INITIAL_CHECKPOINT_STRIDE = 128;
const MAX_CHECKPOINTS_PER_FILE = 4_096;
const MAX_CACHED_LINE_SPANS = 4_096;
const MAX_ACTIVITY_COUNT = 2_048;
const MAX_ACTIVITY_LOGICAL_BYTES = 1024 * 1024;
const CHECKPOINT_LOGICAL_BYTES = 24;
const LINE_SPAN_LOGICAL_BYTES = 32;
const ACTIVITY_OBJECT_LOGICAL_BYTES = 64;
const MAX_BUILD_CONCURRENCY = 2;
const MAX_BUILD_WAITERS = 16;
const MAX_FILE_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

export interface RolloutLineRecord {
  lineNumber: number;
  byteLength: number;
  raw?: string;
  oversized: boolean;
}

export interface RolloutMetadata {
  revision: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  pageSize: number;
  totalBytes: number;
  indexStride: number;
  indexBytes: number;
  summaryComplete: boolean;
  summaryWarning: string | null;
}

export interface RolloutPageData {
  rollout: RolloutMetadata;
  lines: RolloutLineRecord[];
}

export interface RolloutRawChunk {
  revision: string;
  lineNumber: number;
  byteLength: number;
  offset: number;
  nextOffset: number;
  done: boolean;
  raw: string;
}

export interface RolloutReaderDiagnostics {
  cachedFiles: number;
  logicalBytes: number;
  builds: number;
  evictions: number;
  activeBuilds: number;
  maxConcurrentBuilds: number;
  queuedBuilds: number;
}

interface Checkpoint {
  lineNumber: number;
  byteOffset: number;
}

interface LineSpan {
  startOffset: number;
  byteLength: number;
}

interface RolloutIndex {
  filePath: string;
  revision: string;
  totalLines: number;
  totalBytes: number;
  stride: number;
  checkpoints: Checkpoint[];
  spans: Map<number, LineSpan>;
  activities: Map<string, SubagentActivity>;
  activityBytes: number;
  summaryComplete: boolean;
  logicalBytes: number;
}

interface OpenedFile {
  handle: FileHandle;
  filePath: string;
  rootPath: string;
  revision: string;
  size: number;
  identity: string;
}

interface BuildWaiter {
  resolve(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RolloutReaderError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RolloutReaderError";
    this.status = status;
    this.code = code;
  }
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function statIdentity(info: Awaited<ReturnType<FileHandle["stat"]>>): string {
  const big = info as typeof info & {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return [big.dev, big.ino, big.size, big.mtimeNs, big.ctimeNs].map(String).join(":");
}

function sameStatIdentity(left: string, right: string): boolean {
  return left === right;
}

function makeRevision(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function isWithinRoot(rootPath: string, filePath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function staleRevision(): RolloutReaderError {
  return new RolloutReaderError(409, "revision_mismatch", "会话文件已更改，请重新加载当前窗口。");
}

function notFound(): RolloutReaderError {
  return new RolloutReaderError(404, "file_unavailable", "会话轨迹文件不可用。");
}

function asReadError(error: unknown): Error {
  if (error instanceof RolloutReaderError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return notFound();
  return new RolloutReaderError(500, "rollout_read_failed", "读取会话轨迹失败。");
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

function safeUtf8PrefixLength(buffer: Buffer, maxLength: number): number {
  const end = Math.min(buffer.length, maxLength);
  let cursor = end;
  while (cursor > 0 && isUtf8Continuation(buffer[cursor - 1]!)) cursor -= 1;
  const leadIndex = cursor - 1;
  if (leadIndex < 0) return end;
  const expectedLength = utf8SequenceLength(buffer[leadIndex]!);
  if (expectedLength > end - leadIndex) return leadIndex;
  return end;
}

function isUtf8Boundary(buffer: Buffer, offset: number): boolean {
  if (offset <= 0 || offset >= buffer.length) return true;
  return !isUtf8Continuation(buffer[offset]!);
}

function activityLogicalBytes(activity: SubagentActivity): number {
  return ACTIVITY_OBJECT_LOGICAL_BYTES
    + Buffer.byteLength(activity.threadId, "utf8")
    + Buffer.byteLength(activity.agentPath ?? "", "utf8")
    + Buffer.byteLength(activity.status ?? "", "utf8");
}

function nearestCheckpoint(index: RolloutIndex, lineNumber: number): Checkpoint {
  let low = 0;
  let high = index.checkpoints.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index.checkpoints[mid]!.lineNumber <= lineNumber) low = mid + 1;
    else high = mid;
  }
  return index.checkpoints[Math.max(0, low - 1)] ?? { lineNumber: 1, byteOffset: 0 };
}

class IndexBuildGate {
  private active = 0;
  private readonly waiters: BuildWaiter[] = [];
  private observedMax = 0;

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiters.length; }
  get maxObserved(): number { return this.observedMax; }

  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.active < MAX_BUILD_CONCURRENCY) {
      this.active += 1;
      this.observedMax = Math.max(this.observedMax, this.active);
      return Promise.resolve();
    }
    if (this.waiters.length >= MAX_BUILD_WAITERS) {
      throw new RolloutReaderError(503, "index_busy", "会话索引正在繁忙，请稍后重试。");
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: BuildWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class RolloutReaderStore {
  private readonly home: string;
  private readonly cache = new Map<string, RolloutIndex>();
  private readonly buildGate = new IndexBuildGate();
  private cacheLogicalBytes = 0;
  private buildCount = 0;
  private evictionCount = 0;

  constructor(home: string) {
    this.home = path.resolve(home);
  }

  getDiagnostics(): RolloutReaderDiagnostics {
    return {
      cachedFiles: this.cache.size,
      logicalBytes: this.cacheLogicalBytes,
      builds: this.buildCount,
      evictions: this.evictionCount,
      activeBuilds: this.buildGate.activeCount,
      maxConcurrentBuilds: this.buildGate.maxObserved,
      queuedBuilds: this.buildGate.queuedCount,
    };
  }

  async readWindow(filePath: string, line = 1, signal?: AbortSignal): Promise<RolloutPageData & { activities: SubagentActivity[] }> {
    return this.withIndex(filePath, undefined, signal, async (opened, index) => ({
      ...await this.readPageForIndex(opened, index, line, signal),
      activities: [...index.activities.values()],
    }));
  }

  async readPage(filePath: string, revision: string, line: number, signal?: AbortSignal): Promise<RolloutPageData> {
    return this.withIndex(filePath, revision, signal, async (opened, index) => this.readPageForIndex(opened, index, line, signal));
  }

  async readRawChunk(filePath: string, revision: string, lineNumber: number, offset: number, signal?: AbortSignal): Promise<RolloutRawChunk> {
    return this.withIndex(filePath, revision, signal, async (opened, index) => {
      const span = await this.lineSpan(opened, index, lineNumber, signal);
      if (!span) throw new RolloutReaderError(404, "line_not_found", "指定的轨迹行不存在。");
      if (offset > span.byteLength) throw new RolloutReaderError(416, "offset_out_of_range", "原文偏移超出该行范围。");
      if (offset > 0 && offset < span.byteLength) {
        const prefixStart = Math.max(0, offset - 3);
        const prefixLength = Math.min(4, span.byteLength - prefixStart);
        const prefix = await this.readBuffer(opened.handle, span.startOffset + prefixStart, prefixLength, signal);
        if (!isUtf8Boundary(prefix, offset - prefixStart)) {
          throw new RolloutReaderError(416, "offset_not_utf8_boundary", "原文偏移必须落在 UTF-8 字符边界上。");
        }
      }
      const maximum = Math.min(ROLLOUT_MAX_RAW_CHUNK_BYTES, span.byteLength - offset);
      if (maximum === 0) {
        return {
          revision: index.revision,
          lineNumber,
          byteLength: span.byteLength,
          offset,
          nextOffset: offset,
          done: true,
          raw: "",
        };
      }
      const readLength = Math.min(span.byteLength - offset, ROLLOUT_MAX_RAW_CHUNK_BYTES + 3);
      const bytes = await this.readBuffer(opened.handle, span.startOffset + offset, readLength, signal);
      const safeLength = safeUtf8PrefixLength(bytes, maximum);
      const length = safeLength > 0 ? safeLength : Math.min(bytes.length, maximum);
      const nextOffset = offset + length;
      return {
        revision: index.revision,
        lineNumber,
        byteLength: span.byteLength,
        offset,
        nextOffset,
        done: nextOffset >= span.byteLength,
        raw: bytes.subarray(0, length).toString("utf8"),
      };
    });
  }

  async search(filePath: string, revision: string, query: string, afterLine: number, signal?: AbortSignal): Promise<{ revision: string; lineNumber: number | null }> {
    return this.withIndex(filePath, revision, signal, async (opened, index) => {
      const match = await this.searchBytes(opened, index, Buffer.from(query, "utf8"), afterLine, signal);
      return { revision: index.revision, lineNumber: match };
    });
  }

  async *streamLine(filePath: string, revision: string, lineNumber: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const opened = await this.openFile(filePath);
    try {
      const index = await this.getIndex(opened, signal);
      if (index.revision !== revision) throw staleRevision();
      const span = await this.lineSpan(opened, index, lineNumber, signal);
      if (!span) throw new RolloutReaderError(404, "line_not_found", "指定的轨迹行不存在。");
      await this.assertStable(opened);
      let position = span.startOffset;
      let remaining = span.byteLength;
      while (remaining > 0) {
        throwIfAborted(signal);
        const length = Math.min(READ_CHUNK_BYTES, remaining);
        const buffer = await this.readBuffer(opened.handle, position, length, signal);
        if (buffer.length === 0) throw staleRevision();
        position += buffer.length;
        remaining -= buffer.length;
        yield buffer;
      }
      await this.assertStable(opened);
    } catch (error) {
      throw asReadError(error);
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  private async withIndex<T>(
    filePath: string,
    expectedRevision: string | undefined,
    signal: AbortSignal | undefined,
    work: (opened: OpenedFile, index: RolloutIndex) => Promise<T>,
  ): Promise<T> {
    let opened: OpenedFile | undefined;
    try {
      throwIfAborted(signal);
      opened = await this.openFile(filePath);
      if (expectedRevision && opened.revision !== expectedRevision) throw staleRevision();
      const index = await this.getIndex(opened, signal);
      if (expectedRevision && index.revision !== expectedRevision) throw staleRevision();
      const value = await work(opened, index);
      await this.assertStable(opened);
      return value;
    } catch (error) {
      throw asReadError(error);
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }

  private async openFile(filePath: string): Promise<OpenedFile> {
    let handle: FileHandle | undefined;
    try {
      const rootPath = await realpath(this.home);
      const canonical = await realpath(filePath);
      if (!isWithinRoot(rootPath, canonical)) throw notFound();
      const pathInfo = await stat(canonical, { bigint: true });
      if (!pathInfo.isFile()) throw notFound();
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fdInfo = await handle.stat({ bigint: true });
      if (!fdInfo.isFile()) throw notFound();
      const identity = statIdentity(fdInfo);
      const pathIdentity = statIdentity(pathInfo);
      if (!sameStatIdentity(identity, pathIdentity)) throw staleRevision();
      const size = Number(fdInfo.size);
      if (!Number.isSafeInteger(size) || fdInfo.size > MAX_FILE_SIZE) {
        throw new RolloutReaderError(413, "file_too_large", "会话轨迹超过安全读取范围。");
      }
      const opened: OpenedFile = {
        handle,
        filePath: canonical,
        rootPath,
        revision: makeRevision(identity),
        size,
        identity,
      };
      await this.assertStable(opened);
      return opened;
    } catch (error) {
      await handle?.close().catch(() => {});
      throw asReadError(error);
    }
  }

  private async assertStable(opened: OpenedFile): Promise<void> {
    try {
      const rootNow = await realpath(this.home);
      const resolvedNow = await realpath(opened.filePath);
      if (rootNow !== opened.rootPath || !isWithinRoot(rootNow, resolvedNow)) throw staleRevision();
      const [fdInfo, pathInfo] = await Promise.all([
        opened.handle.stat({ bigint: true }),
        stat(resolvedNow, { bigint: true }),
      ]);
      const fdIdentity = statIdentity(fdInfo);
      const pathIdentity = statIdentity(pathInfo);
      if (!fdInfo.isFile() || !pathInfo.isFile()
        || !sameStatIdentity(fdIdentity, opened.identity)
        || !sameStatIdentity(pathIdentity, opened.identity)) throw staleRevision();
    } catch (error) {
      if (error instanceof RolloutReaderError) throw error;
      throw staleRevision();
    }
  }

  private async getIndex(opened: OpenedFile, signal?: AbortSignal): Promise<RolloutIndex> {
    const cached = this.cache.get(opened.filePath);
    if (cached?.revision === opened.revision) {
      this.cache.delete(opened.filePath);
      this.cache.set(opened.filePath, cached);
      return cached;
    }
    if (cached) this.removeCacheEntry(opened.filePath, cached);

    const index = await this.buildGate.run(signal, async () => {
      this.buildCount += 1;
      return this.buildIndex(opened, signal);
    });
    await this.assertStable(opened);
    this.insertCacheEntry(opened.filePath, index);
    return index;
  }

  private async buildIndex(opened: OpenedFile, signal?: AbortSignal): Promise<RolloutIndex> {
    const index: RolloutIndex = {
      filePath: opened.filePath,
      revision: opened.revision,
      totalLines: 0,
      totalBytes: opened.size,
      stride: INITIAL_CHECKPOINT_STRIDE,
      checkpoints: [],
      spans: new Map(),
      activities: new Map(),
      activityBytes: 0,
      summaryComplete: true,
      logicalBytes: 0,
    };

    let lineNumber = 1;
    let lineStart = 0;
    let lineLength = 0;
    let lineChunks: Buffer[] = [];
    let lineTooLong = false;
    let position = 0;
    const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    const append = (chunk: Buffer) => {
      if (!chunk.length) return;
      const nextLength = lineLength + chunk.length;
      if (nextLength > ROLLOUT_MAX_LINE_BYTES) {
        lineTooLong = true;
        lineChunks = [];
      } else if (!lineTooLong) {
        lineChunks.push(Buffer.from(chunk));
      }
      lineLength = nextLength;
    };

    const finishLine = (hasLineFeed: boolean) => {
      if ((lineNumber - 1) % index.stride === 0) {
        index.checkpoints.push({ lineNumber, byteOffset: lineStart });
        this.compactCheckpoints(index);
      }
      if (lineTooLong) index.summaryComplete = false;
      else if (lineChunks.length) this.addLineActivities(index, Buffer.concat(lineChunks, lineLength).toString("utf8"));
      this.cacheLineSpan(index, lineNumber, { startOffset: lineStart, byteLength: lineLength });
      index.totalLines = lineNumber;
      lineNumber += 1;
      lineStart += lineLength + (hasLineFeed ? 1 : 0);
      lineLength = 0;
      lineChunks = [];
      lineTooLong = false;
    };

    while (position < opened.size) {
      throwIfAborted(signal);
      const requested = Math.min(block.length, opened.size - position);
      const { bytesRead } = await opened.handle.read(block, 0, requested, position);
      if (bytesRead === 0) throw staleRevision();
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = block.indexOf(0x0a, cursor);
        if (newline < 0 || newline >= bytesRead) {
          append(block.subarray(cursor, bytesRead));
          break;
        }
        append(block.subarray(cursor, newline));
        finishLine(true);
        cursor = newline + 1;
      }
      position += bytesRead;
    }

    if (lineLength > 0) finishLine(false);
    index.logicalBytes = this.indexLogicalBytes(index);
    await this.assertStable(opened);
    return index;
  }

  private compactCheckpoints(index: RolloutIndex): void {
    while (index.checkpoints.length > MAX_CHECKPOINTS_PER_FILE) {
      index.stride *= 2;
      index.checkpoints = index.checkpoints.filter((checkpoint) => checkpoint.lineNumber === 1
        || (checkpoint.lineNumber - 1) % index.stride === 0);
    }
  }

  private addLineActivities(index: RolloutIndex, line: string): void {
    for (const activity of subagentActivityFromRollout(line)) {
      const existing = index.activities.get(activity.threadId);
      const merged = {
        ...activity,
        agentPath: activity.agentPath ?? existing?.agentPath ?? null,
        status: activity.status ?? existing?.status ?? null,
      };
      const previousCost = existing ? activityLogicalBytes(existing) : 0;
      const nextCost = activityLogicalBytes(merged);
      const nextBytes = index.activityBytes - previousCost + nextCost;
      if (!existing && index.activities.size >= MAX_ACTIVITY_COUNT || nextBytes > MAX_ACTIVITY_LOGICAL_BYTES) {
        if (existing) index.activities.delete(activity.threadId);
        index.activityBytes -= previousCost;
        index.summaryComplete = false;
        continue;
      }
      index.activities.set(activity.threadId, merged);
      index.activityBytes = nextBytes;
    }
  }

  private indexLogicalBytes(index: RolloutIndex): number {
    return index.checkpoints.length * CHECKPOINT_LOGICAL_BYTES
      + index.spans.size * LINE_SPAN_LOGICAL_BYTES
      + index.activityBytes;
  }

  private cacheLineSpan(index: RolloutIndex, lineNumber: number, span: LineSpan): void {
    const existing = index.spans.get(lineNumber);
    if (existing) index.spans.delete(lineNumber);
    index.spans.set(lineNumber, span);
    while (index.spans.size > MAX_CACHED_LINE_SPANS) {
      const oldest = index.spans.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      index.spans.delete(oldest);
    }
    this.updateCachedLogicalBytes(index);
  }

  private updateCachedLogicalBytes(index: RolloutIndex): void {
    const old = index.logicalBytes;
    index.logicalBytes = this.indexLogicalBytes(index);
    if (this.cache.get(index.filePath) !== index) return;
    this.cacheLogicalBytes += index.logicalBytes - old;
    this.enforceCacheBudget();
  }

  private insertCacheEntry(filePath: string, index: RolloutIndex): void {
    const previous = this.cache.get(filePath);
    if (previous) this.removeCacheEntry(filePath, previous);
    if (index.logicalBytes > ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES) return;
    this.cache.set(filePath, index);
    this.cacheLogicalBytes += index.logicalBytes;
    this.enforceCacheBudget();
  }

  private removeCacheEntry(filePath: string, index: RolloutIndex): void {
    if (this.cache.get(filePath) !== index) return;
    this.cache.delete(filePath);
    this.cacheLogicalBytes = Math.max(0, this.cacheLogicalBytes - index.logicalBytes);
  }

  private enforceCacheBudget(): void {
    while (this.cache.size > ROLLOUT_INDEX_CACHE_MAX_FILES
      || this.cacheLogicalBytes > ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES) {
      const oldestPath = this.cache.keys().next().value as string | undefined;
      if (oldestPath === undefined) break;
      const oldest = this.cache.get(oldestPath);
      if (oldest) this.removeCacheEntry(oldestPath, oldest);
      this.evictionCount += 1;
    }
  }

  private async readPageForIndex(opened: OpenedFile, index: RolloutIndex, requestedLine: number, signal?: AbortSignal): Promise<RolloutPageData> {
    const normalizedLine = index.totalLines === 0 ? 0 : Math.min(Math.max(1, requestedLine), index.totalLines);
    const startLine = normalizedLine === 0 ? 0 : Math.floor((normalizedLine - 1) / ROLLOUT_PAGE_SIZE) * ROLLOUT_PAGE_SIZE + 1;
    const endLine = startLine === 0 ? 0 : Math.min(index.totalLines, startLine + ROLLOUT_PAGE_SIZE - 1);
    const lines = startLine === 0 ? [] : await this.readLines(opened, index, startLine, endLine, signal);
    return {
      rollout: {
        revision: index.revision,
        totalLines: index.totalLines,
        startLine,
        endLine: lines.at(-1)?.lineNumber ?? 0,
        pageSize: ROLLOUT_PAGE_SIZE,
        totalBytes: index.totalBytes,
        indexStride: index.stride,
        indexBytes: index.logicalBytes,
        summaryComplete: index.summaryComplete,
        summaryWarning: index.summaryComplete ? null : "子代理状态摘要不完整：存在超长轨迹行或超出摘要缓存上限的活动记录。",
      },
      lines,
    };
  }

  private async readLines(opened: OpenedFile, index: RolloutIndex, firstLine: number, lastLine: number, signal?: AbortSignal): Promise<RolloutLineRecord[]> {
    const checkpoint = nearestCheckpoint(index, firstLine);
    let lineNumber = checkpoint.lineNumber;
    let lineStart = checkpoint.byteOffset;
    let lineLength = 0;
    let lineChunks: Buffer[] = [];
    let lineTooLong = false;
    let position = checkpoint.byteOffset;
    const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const lines: RolloutLineRecord[] = [];

    const append = (chunk: Buffer) => {
      if (!chunk.length) return;
      const nextLength = lineLength + chunk.length;
      if (nextLength > ROLLOUT_MAX_LINE_BYTES) {
        lineTooLong = true;
        lineChunks = [];
      } else if (!lineTooLong && lineNumber >= firstLine) {
        lineChunks.push(Buffer.from(chunk));
      }
      lineLength = nextLength;
    };

    const finishLine = (hasLineFeed: boolean) => {
      if (lineNumber >= firstLine && lineNumber <= lastLine) {
        const record: RolloutLineRecord = {
          lineNumber,
          byteLength: lineLength,
          oversized: lineTooLong,
        };
        if (!lineTooLong) record.raw = lineChunks.length ? Buffer.concat(lineChunks, lineLength).toString("utf8") : "";
        lines.push(record);
      }
      this.cacheLineSpan(index, lineNumber, { startOffset: lineStart, byteLength: lineLength });
      lineNumber += 1;
      lineStart += lineLength + (hasLineFeed ? 1 : 0);
      lineLength = 0;
      lineChunks = [];
      lineTooLong = false;
    };

    while (position < opened.size && lineNumber <= lastLine) {
      throwIfAborted(signal);
      const requested = Math.min(block.length, opened.size - position);
      const { bytesRead } = await opened.handle.read(block, 0, requested, position);
      if (bytesRead === 0) throw staleRevision();
      let cursor = 0;
      while (cursor < bytesRead && lineNumber <= lastLine) {
        const newline = block.indexOf(0x0a, cursor);
        if (newline < 0 || newline >= bytesRead) {
          append(block.subarray(cursor, bytesRead));
          break;
        }
        append(block.subarray(cursor, newline));
        finishLine(true);
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    if (lineNumber <= lastLine && lineLength > 0) finishLine(false);
    return lines;
  }

  private async lineSpan(opened: OpenedFile, index: RolloutIndex, lineNumber: number, signal?: AbortSignal): Promise<LineSpan | null> {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > index.totalLines) return null;
    const cached = index.spans.get(lineNumber);
    if (cached) {
      index.spans.delete(lineNumber);
      index.spans.set(lineNumber, cached);
      return cached;
    }
    const checkpoint = nearestCheckpoint(index, lineNumber);
    let currentLine = checkpoint.lineNumber;
    let lineStart = checkpoint.byteOffset;
    let lineLength = 0;
    let position = checkpoint.byteOffset;
    const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (position < opened.size) {
      throwIfAborted(signal);
      const requested = Math.min(block.length, opened.size - position);
      const { bytesRead } = await opened.handle.read(block, 0, requested, position);
      if (bytesRead === 0) throw staleRevision();
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = block.indexOf(0x0a, cursor);
        if (newline < 0 || newline >= bytesRead) {
          lineLength += bytesRead - cursor;
          break;
        }
        lineLength += newline - cursor;
        if (currentLine === lineNumber) {
          const span = { startOffset: lineStart, byteLength: lineLength };
          this.cacheLineSpan(index, currentLine, span);
          return span;
        }
        currentLine += 1;
        lineStart = position + newline + 1;
        lineLength = 0;
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    if (lineLength > 0 && currentLine === lineNumber) {
      const span = { startOffset: lineStart, byteLength: lineLength };
      this.cacheLineSpan(index, currentLine, span);
      return span;
    }
    return null;
  }

  private async searchBytes(opened: OpenedFile, index: RolloutIndex, query: Buffer, afterLine: number, signal?: AbortSignal): Promise<number | null> {
    if (afterLine >= index.totalLines) return null;
    const firstLine = Math.max(1, afterLine + 1);
    const checkpoint = nearestCheckpoint(index, firstLine);
    let lineNumber = checkpoint.lineNumber;
    let position = checkpoint.byteOffset;
    let overlap = Buffer.alloc(0);
    const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    const matches = (segment: Buffer): boolean => {
      if (lineNumber <= afterLine) return false;
      if (segment.length === 0) return false;
      const combined = overlap.length ? Buffer.concat([overlap, segment]) : segment;
      const found = combined.indexOf(query) >= 0;
      const keep = Math.min(Math.max(query.length - 1, 0), combined.length);
      overlap = keep ? Buffer.from(combined.subarray(combined.length - keep)) : Buffer.alloc(0);
      return found;
    };

    while (position < opened.size) {
      throwIfAborted(signal);
      const requested = Math.min(block.length, opened.size - position);
      const { bytesRead } = await opened.handle.read(block, 0, requested, position);
      if (bytesRead === 0) throw staleRevision();
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = block.indexOf(0x0a, cursor);
        if (newline < 0 || newline >= bytesRead) {
          if (matches(block.subarray(cursor, bytesRead))) return lineNumber;
          break;
        }
        if (matches(block.subarray(cursor, newline))) return lineNumber;
        overlap = Buffer.alloc(0);
        lineNumber += 1;
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    return null;
  }

  private async readBuffer(handle: FileHandle, position: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      throwIfAborted(signal);
      const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead);
  }
}
