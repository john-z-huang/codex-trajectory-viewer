import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { previewFromRecord } from "../src/lib/rollout.js";
import { isGuardianSession, subagentMetadataFromSession } from "./subagents.js";

const encodeId = (relativePath) => Buffer.from(relativePath).toString("base64url");

async function collectRollouts(home) {
  const found = [];
  for (const [directory, archived] of [["sessions", false], ["archived_sessions", true]]) {
    const base = path.join(home, directory);
    try {
      if (!(await lstat(base)).isDirectory()) continue;
    } catch {
      continue;
    }

    async function walk(current) {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(candidate);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          found.push({ candidate, archived, relativePath: path.relative(home, candidate) });
        }
      }
    }

    await walk(base);
  }
  return found;
}

export function mergeThreadSummary(session, row = {}) {
  const archived = row.archived == null
    ? session.archived
    : typeof row.archived === "string"
      ? /^(1|true|yes)$/i.test(row.archived)
      : Boolean(row.archived);
  const updatedAtMs = Number(row.updated_at_ms);
  const updatedAt = row.updated_at ?? (
    row.updated_at_ms != null
      && Number.isFinite(updatedAtMs)
      && !Number.isNaN(new Date(updatedAtMs).valueOf())
      ? new Date(updatedAtMs).toISOString()
      : session.timestamp
  );
  const titleCandidates = [
    row.name,
    row.title,
    session._metadataName,
    session._metadataTitle,
    row.preview,
    row.first_user_message,
    session._initialUserMessage,
    session.preview,
  ];
  const title = titleCandidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim()
    ?? row.title
    ?? session.preview;
  return {
    ...Object.fromEntries(Object.entries(session).filter(([key]) => !key.startsWith("_"))),
    title,
    cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : session.cwd,
    model: row.model ?? null,
    tokens_used: row.tokens_used ?? null,
    source: row.source ?? null,
    agent: session._agent ?? null,
    guardian: Boolean(session._guardian),
    archived,
    updatedAt,
  };
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
      const basename = path.basename(file.candidate);
      const filenameMatch = basename.match(/^rollout-(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
      const filenameSessionId = filenameMatch?.[1] ?? null;
      let metadata = null;
      let matchingMetadata = null;
      let preview = "";
      let firstTimestamp = null;
      for (const line of records) {
        try {
          const record = JSON.parse(line);
          firstTimestamp ??= record.timestamp ?? null;
          if (record.type === "session_meta" || record.type === "session_meta_entry") {
            metadata = record.payload ?? {};
            const metadataId = metadata.id ?? metadata.thread_id;
            if (!matchingMetadata && filenameSessionId && metadataId === filenameSessionId) {
              matchingMetadata = metadata;
            }
          }
          preview ||= previewFromRecord(record);
        } catch {
          // Malformed lines remain available in the detail view.
        }
      }
      metadata = matchingMetadata ?? metadata;
      const id = metadata?.id ?? metadata?.thread_id ?? filenameSessionId ?? basename;
      sessions.push({
        id: encodeId(file.relativePath),
        sessionId: id,
        archived: file.archived,
        preview: preview || metadata?.initial_user_message || "无用户消息预览",
        cwd: metadata?.cwd ?? "",
        timestamp: firstTimestamp ?? info.mtime.toISOString(),
        filename: basename,
        _path: resolved,
        _relativePath: file.relativePath,
        _agent: subagentMetadataFromSession(metadata),
        _guardian: isGuardianSession(metadata),
        _metadataName: metadata?.name,
        _metadataTitle: metadata?.title,
        _initialUserMessage: metadata?.initial_user_message,
      });
    } catch {
      // Unreadable files are skipped; discovered files remain strictly allowlisted.
    }
  }
  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
