import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { previewFromRecord } from "../src/lib/rollout.js";
import { readSessionSupplement, readThreadSummaries } from "./sqlite-reader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const encodeId = (relativePath) => Buffer.from(relativePath).toString("base64url");

function mergeThreadSummary(session, row = {}) {
  const archived = row.archived == null ? session.archived : typeof row.archived === "string" ? /^(1|true|yes)$/i.test(row.archived) : Boolean(row.archived);
  const updatedAtMs = Number(row.updated_at_ms);
  const updatedAt = row.updated_at ?? (row.updated_at_ms != null && Number.isFinite(updatedAtMs) && !Number.isNaN(new Date(updatedAtMs).valueOf()) ? new Date(updatedAtMs).toISOString() : session.timestamp);
  return {
    ...Object.fromEntries(Object.entries(session).filter(([key]) => !key.startsWith("_"))),
    title: typeof row.title === "string" && row.title.trim() ? row.title : session.preview,
    cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : session.cwd,
    model: row.model ?? null,
    tokens_used: row.tokens_used ?? null,
    source: row.source ?? null,
    archived,
    updatedAt,
  };
}

async function collectRollouts(home) {
  const found = [];
  for (const [directory, archived] of [["sessions", false], ["archived_sessions", true]]) {
    const base = path.join(home, directory);
    try { if (!(await lstat(base)).isDirectory()) continue; } catch { continue; }
    async function walk(current) {
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(candidate);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push({ candidate, archived, relativePath: path.relative(home, candidate) });
      }
    }
    await walk(base);
  }
  return found;
}

export async function discoverSessions(home) {
  const root = await realpath(home).catch(() => path.resolve(home));
  const files = await collectRollouts(root);
  const sessions = [];
  for (const file of files) {
    try {
      const resolved = await realpath(file.candidate);
      if (!resolved.startsWith(`${root}${path.sep}`)) continue;
      const info = await stat(resolved);
      const stream = createReadStream(resolved, { encoding: "utf8", start: 0, end: 128 * 1024 - 1 });
      let content = "";
      for await (const chunk of stream) content += chunk;
      const records = content.split(/\r?\n/).slice(0, 8);
      let metadata = null;
      let preview = "";
      let firstTimestamp = null;
      for (const line of records) {
        try {
          const record = JSON.parse(line);
          firstTimestamp ??= record.timestamp ?? null;
          if (record.type === "session_meta") metadata = record.payload ?? {};
          preview ||= previewFromRecord(record);
        } catch { /* malformed lines remain available in the detail view */ }
      }
      const basename = path.basename(file.candidate);
      const match = basename.match(/^rollout-(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
      const id = metadata?.id ?? metadata?.thread_id ?? match?.[1] ?? basename;
      sessions.push({ id: encodeId(file.relativePath), sessionId: id, archived: file.archived, preview: preview || metadata?.initial_user_message || "无用户消息预览", cwd: metadata?.cwd ?? "", timestamp: firstTimestamp ?? info.mtime.toISOString(), filename: basename, _path: resolved, _relativePath: file.relativePath });
    } catch { /* unreadable files are skipped; discovered files remain strictly allowlisted */ }
  }
  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function createAppServer(options = {}) {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sqliteHome = options.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? home;
  const root = options.root ?? ROOT;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (url.pathname === "/api/sessions") {
      const sessions = await discoverSessions(home);
      const threads = await readThreadSummaries(sqliteHome, sessions);
      const summaries = sessions.map((session) => mergeThreadSummary(session, threads.get(String(session.sessionId))));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(summaries));
      return;
    }
    if (url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.slice("/api/sessions/".length);
      let decoded;
      try { decoded = Buffer.from(id, "base64url").toString(); } catch { decoded = ""; }
      const sessions = await discoverSessions(home);
      const match = sessions.find((session) => session.id === id && session._relativePath === decoded);
      if (!match) { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Session not found" })); return; }
      const contents = await readFile(match._path, "utf8");
      const thread = (await readThreadSummaries(sqliteHome, [match])).get(String(match.sessionId));
      const requestedHistoryPage = Number(url.searchParams.get("historyPage") ?? 1);
      const historyPage = Number.isSafeInteger(requestedHistoryPage) && requestedHistoryPage > 0 ? Math.min(requestedHistoryPage, 10_000) : 1;
      const supplement = await readSessionSupplement(sqliteHome, match, { historyPage });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ...mergeThreadSummary(match, thread), contents, supplement }));
      return;
    }
    if (url.pathname.startsWith("/api/")) { response.writeHead(404).end(); return; }
    const dist = path.join(root, "dist");
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const target = path.resolve(dist, requested);
    if (!target.startsWith(`${dist}${path.sep}`) && target !== path.join(dist, "index.html")) { response.writeHead(404).end(); return; }
    try {
      const fileStat = await stat(target);
      if (!fileStat.isFile()) throw new Error("not a file");
      response.writeHead(200, { "Content-Type": target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream" });
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end("Run npm run build to create the web app."); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  createAppServer().listen(port, "127.0.0.1", () => console.log(`Codex trajectory viewer listening on http://127.0.0.1:${port}`));
}
