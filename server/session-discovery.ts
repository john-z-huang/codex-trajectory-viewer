import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error This shared legacy JavaScript helper is intentionally outside the server-only TS compilation.
import { previewFromRecord } from "../src/lib/rollout.js";
import { isGuardianSession, subagentMetadataFromSession } from "./subagents.js";
import { isJsonRecord, type JsonRecord, type Session, type SessionSummary } from "./types.js";
import type { AppLogger, LoggerContext } from "./logger.js";

const encodeId = (relativePath: string): string => Buffer.from(relativePath).toString("base64url");

interface RolloutFile {
  candidate: string;
  archived: boolean;
  relativePath: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type SkipCounts = { missing_count: number; permission_count: number; unsafe_count: number; io_count: number };

function countSkip(counts: SkipCounts, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") counts.missing_count += 1;
  else if (code === "EACCES" || code === "EPERM") counts.permission_count += 1;
  else counts.io_count += 1;
}

async function collectRollouts(home: string): Promise<{ files: RolloutFile[]; dirsSkipped: number; skipped: SkipCounts }> {
  const found: RolloutFile[] = [];
  let dirsSkipped = 0;
  const skipped: SkipCounts = { missing_count: 0, permission_count: 0, unsafe_count: 0, io_count: 0 };
  for (const [directory, archived] of [["sessions", false], ["archived_sessions", true]] as const) {
    const base = path.join(home, directory);
    try {
      if (!(await lstat(base)).isDirectory()) { dirsSkipped += 1; skipped.unsafe_count += 1; continue; }
    } catch (error) {
      dirsSkipped += 1;
      countSkip(skipped, error);
      continue;
    }

    async function walk(current: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        dirsSkipped += 1;
        countSkip(skipped, error);
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
  return { files: found, dirsSkipped, skipped };
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

export async function discoverSessions(home: string, logger?: AppLogger, context?: LoggerContext): Promise<Session[]> {
  const root = await realpath(home).catch(() => path.resolve(home));
  const collected = await collectRollouts(root);
  const files = collected.files;
  const sessions = [];
  let filesSkipped = 0;
  for (const file of files) {
    try {
      const resolved = await realpath(file.candidate);
      if (!resolved.startsWith(`${root}${path.sep}`)) { filesSkipped += 1; collected.skipped.unsafe_count += 1; continue; }
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
    } catch (error) {
      // Unreadable files are skipped; discovered files remain strictly allowlisted.
      filesSkipped += 1;
      countSkip(collected.skipped, error);
    }
  }
  const sorted = sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  logger?.emit("discovery_complete", { sessions: sorted.length, dirs_skipped: collected.dirsSkipped, files_skipped: filesSkipped, ...collected.skipped }, context);
  return sorted;
}
