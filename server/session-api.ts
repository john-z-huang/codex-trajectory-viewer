import { readFile } from "node:fs/promises";
import { RolloutReaderError, type RolloutReaderStore } from "./rollout-reader.js";
import { readSessionSupplement, readSupplementRevision, readThreadSummaries } from "./sqlite-reader.js";
import { linkSubagents, subagentActivityFromRollout } from "./subagents.js";
import { discoverSessions, mergeThreadSummary } from "./session-discovery.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session, SessionSummary, SubagentActivity } from "./types.js";

interface SessionApiOptions {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  home: string;
  sqliteHome: string;
  reader: RolloutReaderStore;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function queryInteger(url: URL, name: string, minimum: number, fallback?: number): number | null | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function validRevision(url: URL): string | null {
  const revision = url.searchParams.get("revision");
  return revision && revision.length <= 256 ? revision : null;
}

function sendReadError(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (error instanceof RolloutReaderError) {
    sendJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof Error && error.name === "AbortError") return;
  sendJson(response, 500, { error: "Unable to read rollout" });
}

function readAbortContext(request: IncomingMessage, response: ServerResponse): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAborted = () => controller.abort();
  const onClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", onAborted);
  response.once("close", onClose);
  if ((request.destroyed && !request.complete) || response.destroyed) controller.abort();
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", onAborted);
      response.off("close", onClose);
    },
  };
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

async function writeChunkWithBackpressure(response: ServerResponse, chunk: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) throw abortError();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(abortError()); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || response.destroyed) onAbort();
    else if (!response.writableNeedDrain) onDrain();
  });
}

async function sendLineDownload(
  reader: RolloutReaderStore,
  filePath: string,
  revision: string,
  lineNumber: number,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const iterator = reader.streamLine(filePath, revision, lineNumber, signal)[Symbol.asyncIterator]();
  try {
    let next = await iterator.next();
    if (signal.aborted) return;
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="rollout-line-${lineNumber}.txt"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    while (!next.done) {
      await writeChunkWithBackpressure(response, next.value, signal);
      next = await iterator.next();
    }
    if (!response.destroyed) response.end();
  } catch (error) {
    if (response.headersSent) response.destroy();
    else sendReadError(response, error);
  } finally {
    try { await iterator.return?.(undefined); } catch { /* The response is already ending. */ }
  }
}

async function buildSubagentProjection(
  parent: Session,
  sessions: Session[],
  activities: SubagentActivity[],
  sqliteHome: string,
) {
  const linkedSubagents = linkSubagents(parent, sessions, activities);
  const childSessions = linkedSubagents
    .map((link) => link.session)
    .filter((session): session is Session => session !== null);
  const childThreads = await readThreadSummaries(sqliteHome, childSessions);
  const subagents = linkedSubagents.map((link) => {
    if (!link.session) {
      return {
        threadId: link.threadId,
        agent: link.agent,
        activityStatus: link.status,
        available: false,
        reason: link.reason,
      };
    }
    return {
      ...mergeThreadSummary(link.session, childThreads.get(String(link.session.sessionId))),
      threadId: link.threadId,
      agent: link.agent ?? link.session._agent,
      activityStatus: link.status,
      available: true,
      reason: null,
    };
  });
  return subagents;
}

function withRolloutWarnings<T extends { summaryWarning: string | null }>(rollout: T) {
  const { summaryWarning, ...metadata } = rollout;
  return { ...metadata, warnings: summaryWarning ? [summaryWarning] : [] };
}

export async function handleSessionApi({ request, response, url, home, sqliteHome, reader }: SessionApiOptions): Promise<boolean> {
  if (url.pathname === "/api/sessions") {
    const sessions: Session[] = await discoverSessions(home);
    const threads = await readThreadSummaries(sqliteHome, sessions);
    const summaries: SessionSummary[] = sessions.map((session) => mergeThreadSummary(session, threads.get(String(session.sessionId))));
    const sessionsByThreadId = new Map(summaries.map((session) => [String(session.sessionId), session]));
    for (const session of summaries) {
      const agent = session.agent;
      const parentThreadId = agent?.parentThreadId;
      if (!parentThreadId) continue;
      const parent = agent.conflict ? null : sessionsByThreadId.get(String(parentThreadId));
      session.projectCwd = session.cwd || parent?.cwd || "";
      session.agent = {
        ...agent,
        parentSessionId: parent?.id ?? null,
        parentTitle: parent?.title || parent?.preview || null,
      };
    }
    sendJson(response, 200, summaries);
    return true;
  }

  if (!url.pathname.startsWith("/api/sessions/")) return false;

  const id = url.pathname.slice("/api/sessions/".length);
  let decoded;
  try {
    decoded = Buffer.from(id, "base64url").toString();
  } catch {
    decoded = "";
  }
  const sessions = await discoverSessions(home);
  const match = sessions.find((session) => session.id === id && session._relativePath === decoded);
  if (!match) {
    sendJson(response, 404, { error: "Session not found" });
    return true;
  }

  const requestedHistoryPage = Number(url.searchParams.get("historyPage") ?? 1);
  const historyPage = Number.isSafeInteger(requestedHistoryPage) && requestedHistoryPage > 0
    ? Math.min(requestedHistoryPage, 10_000)
    : 1;
  const view = url.searchParams.get("view");
  if (view === "history") {
    const expected = url.searchParams.get("supplementRevision");
    const before = await readSupplementRevision(sqliteHome);
    if (expected !== null && expected !== before) {
      sendJson(response, 409, { code: "stale_revision", error: "SQLite 数据已变化，请点击「刷新」加载新内容。" });
      return true;
    }
    const supplement = await readSessionSupplement(sqliteHome, match, { historyPage });
    if (expected !== null && await readSupplementRevision(sqliteHome) !== before) {
      sendJson(response, 409, { code: "stale_revision", error: "SQLite 数据已变化，请点击「刷新」加载新内容。" });
      return true;
    }
    sendJson(response, 200, { supplement });
    return true;
  }

  const pagedViews = new Set(["window", "page", "raw", "download", "search"]);
  if (view !== null && !pagedViews.has(view)) {
    sendJson(response, 400, { error: "Unsupported session view", code: "invalid_view" });
    return true;
  }

  if (view !== null) {
    const cancellation = readAbortContext(request, response);
    try {
      if (view === "window") {
        const line = queryInteger(url, "line", 1, 1);
        if (line == null) {
          sendJson(response, 400, { error: "line must be a positive safe integer", code: "invalid_line" });
          return true;
        }
        const supplementRevision = await readSupplementRevision(sqliteHome);
        const [window, threads, supplement] = await Promise.all([
          reader.readWindow(match._path, line, cancellation.signal),
          readThreadSummaries(sqliteHome, [match]),
          readSessionSupplement(sqliteHome, match, { historyPage }),
        ]);
        const activities = window.activities;
        const subagents = await buildSubagentProjection(match, sessions, activities, sqliteHome);
        if (await readSupplementRevision(sqliteHome) !== supplementRevision) {
          sendJson(response, 409, { code: "stale_revision", error: "SQLite 数据在读取时发生变化，请点击「刷新」重试。" });
          return true;
        }
        sendJson(response, 200, {
          ...mergeThreadSummary(match, threads.get(String(match.sessionId))),
          supplement,
          supplementRevision,
          subagents,
          rollout: withRolloutWarnings(window.rollout),
          lines: window.lines,
        });
        return true;
      }

      const revision = validRevision(url);
      if (!revision) {
        sendJson(response, 400, { error: "revision is required", code: "invalid_revision" });
        return true;
      }

      if (view === "page") {
        const line = queryInteger(url, "line", 1);
        if (line == null) {
          sendJson(response, 400, { error: "line must be a positive safe integer", code: "invalid_line" });
          return true;
        }
        sendJson(response, 200, await reader.readPage(match._path, revision, line, cancellation.signal));
        return true;
      }

      if (view === "raw" || view === "download") {
        const line = queryInteger(url, "line", 1);
        if (line == null) {
          sendJson(response, 400, { error: "line must be a positive safe integer", code: "invalid_line" });
          return true;
        }
        if (view === "download") {
          await sendLineDownload(reader, match._path, revision, line, response, cancellation.signal);
          return true;
        }
        const offset = queryInteger(url, "offset", 0, 0);
        if (offset == null) {
          sendJson(response, 400, { error: "offset must be a non-negative safe integer", code: "invalid_offset" });
          return true;
        }
        sendJson(response, 200, await reader.readRawChunk(match._path, revision, line, offset, cancellation.signal));
        return true;
      }

      if (view === "search") {
        const query = url.searchParams.get("q");
        if (!query || query.length > 256) {
          sendJson(response, 400, { error: "q must contain 1 to 256 UTF-16 code units", code: "invalid_query" });
          return true;
        }
        const afterLine = queryInteger(url, "afterLine", 0, 0);
        if (afterLine == null) {
          sendJson(response, 400, { error: "afterLine must be a non-negative safe integer", code: "invalid_after_line" });
          return true;
        }
        sendJson(response, 200, await reader.search(match._path, revision, query, afterLine, cancellation.signal));
        return true;
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
      } else {
        sendReadError(response, error);
      }
      return true;
    } finally {
      cancellation.dispose();
    }
  }

  const contents = await readFile(match._path, "utf8");
  const thread = (await readThreadSummaries(sqliteHome, [match])).get(String(match.sessionId));
  const activities = subagentActivityFromRollout(contents);
  const subagents = await buildSubagentProjection(match, sessions, activities, sqliteHome);
  const supplement = await readSessionSupplement(sqliteHome, match, { historyPage });
  sendJson(response, 200, { ...mergeThreadSummary(match, thread), contents, supplement, subagents });
  return true;
}
