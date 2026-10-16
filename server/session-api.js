import { readFile } from "node:fs/promises";
import { readSessionSupplement, readThreadSummaries } from "./sqlite-reader.js";
import { linkSubagents, subagentActivityFromRollout } from "./subagents.js";
import { discoverSessions, mergeThreadSummary } from "./session-discovery.js";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export async function handleSessionApi({ request, response, url, home, sqliteHome }) {
  if (url.pathname === "/api/sessions") {
    const sessions = await discoverSessions(home);
    const threads = await readThreadSummaries(sqliteHome, sessions);
    const summaries = sessions.map((session) => mergeThreadSummary(session, threads.get(String(session.sessionId))));
    const sessionsByThreadId = new Map(summaries.map((session) => [String(session.sessionId), session]));
    for (const session of summaries) {
      const parentThreadId = session.agent?.parentThreadId;
      if (!parentThreadId) continue;
      const parent = session.agent.conflict ? null : sessionsByThreadId.get(String(parentThreadId));
      session.projectCwd = session.cwd || parent?.cwd || "";
      session.agent = {
        ...session.agent,
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

  const contents = await readFile(match._path, "utf8");
  const thread = (await readThreadSummaries(sqliteHome, [match])).get(String(match.sessionId));
  const linkedSubagents = linkSubagents(match, sessions, subagentActivityFromRollout(contents));
  const childSessions = linkedSubagents.map((link) => link.session).filter(Boolean);
  const childThreads = await readThreadSummaries(sqliteHome, childSessions);
  const requestedHistoryPage = Number(url.searchParams.get("historyPage") ?? 1);
  const historyPage = Number.isSafeInteger(requestedHistoryPage) && requestedHistoryPage > 0
    ? Math.min(requestedHistoryPage, 10_000)
    : 1;
  const supplement = await readSessionSupplement(sqliteHome, match, { historyPage });
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
  sendJson(response, 200, { ...mergeThreadSummary(match, thread), contents, supplement, subagents });
  return true;
}
