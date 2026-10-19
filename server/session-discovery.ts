import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error This shared legacy JavaScript helper is intentionally outside the server-only TS compilation.
import { previewFromRecord } from "../src/lib/rollout.js";
import { isGuardianSession, subagentMetadataFromSession } from "./subagents.js";
import { isJsonRecord, type JsonRecord, type Session, type SessionSummary } from "./types.js";

const encodeId = (relativePath: string): string => Buffer.from(relativePath).toString("base64url");

interface RolloutFile {
  candidate: string;
  archived: boolean;
  relativePath: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function collectRollouts(home: string): Promise<RolloutFile[]> {
  const found: RolloutFile[] = [];
  for (const [directory, archived] of [["sessions", false], ["archived_sessions", true]] as const) {
    const base = path.join(home, directory);
    try {
      if (!(await lstat(base)).isDirectory()) continue;
    } catch {
      continue;
    }

    async function walk(current: string): Promise<void> {
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

export function mergeThreadSummary(session: Session, row: JsonRecord = {}): SessionSummary {
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
  const titleCandidates: unknown[] = [
    row.name,
    row.title,
    session._metadataName,
    session._metadataTitle,
    row.preview,
    row.first_user_message,
    session._initialUserMessage,
    session.preview,
  ];
  const title = titleCandidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim()
    ?? stringValue(row.title)
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
  } as SessionSummary;
}

export async function discoverSessions(home: string): Promise<Session[]> {
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
      let metadata: JsonRecord | null = null;
      let matchingMetadata: JsonRecord | null = null;
      let preview = "";
      let firstTimestamp = null;
      for (const line of records) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isJsonRecord(parsed)) continue;
          const record = parsed;
          firstTimestamp ??= stringValue(record.timestamp) ?? null;
          if (record.type === "session_meta" || record.type === "session_meta_entry") {
            metadata = isJsonRecord(record.payload) ? record.payload : {};
            const metadataId = metadata.id ?? metadata.thread_id;
            if (!matchingMetadata && filenameSessionId && metadataId === filenameSessionId) {
              matchingMetadata = metadata;
            }
          }
          preview ||= String(previewFromRecord(record) || "");
        } catch {
          // Malformed lines remain available in the detail view.
        }
      }
      metadata = matchingMetadata ?? metadata;
      const id = stringValue(metadata?.id) ?? stringValue(metadata?.thread_id) ?? filenameSessionId ?? basename;
      const metadataInitialMessage = stringValue(metadata?.initial_user_message);
      sessions.push({
        id: encodeId(file.relativePath),
        sessionId: id,
        archived: file.archived,
        preview: preview || metadataInitialMessage || "无用户消息预览",
        cwd: stringValue(metadata?.cwd) ?? "",
        timestamp: firstTimestamp ?? info.mtime.toISOString(),
        filename: basename,
        _path: resolved,
        _relativePath: file.relativePath,
        _agent: subagentMetadataFromSession(metadata),
        _guardian: isGuardianSession(metadata),
        _metadataName: stringValue(metadata?.name),
        _metadataTitle: stringValue(metadata?.title),
        _initialUserMessage: metadataInitialMessage,
      });
    } catch {
      // Unreadable files are skipped; discovered files remain strictly allowlisted.
    }
  }
  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
