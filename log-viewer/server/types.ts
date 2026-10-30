export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "server" | "http" | "browser";

/** A safe, public description of one discovered JSONL segment. */
export interface LogFile {
  id: string;
  date: string;
  source: LogSource;
  instanceId: string;
  segment: number;
  name: string;
  size: number;
  modifiedAt: string;
}

/** A discovered file plus the filesystem facts needed to reopen it safely. */
export interface LogFileDescriptor extends LogFile {
  filePath: string;
  datePath: string;
  dateDev: string;
  dateIno: string;
  dev: string;
  ino: string;
}

export interface LogEntry {
  /** One-based physical line number in the original file. */
  line: number;
  /** At most 64 KiB of decoded UTF-8 from the original line. */
  raw: string;
  /** Parsed object record, or null when the row is invalid or too large. */
  record: Record<string, unknown> | null;
  error: string | null;
  truncated: boolean;
}

export interface LogPage {
  file: LogFile;
  revision: string;
  totalLines: number;
  matchedLines: number;
  entries: LogEntry[];
  hasMore: boolean;
  nextAfterLine: number;
}

export interface LogList {
  files: LogFile[];
  warnings: number;
}

/** Signed by the reader process; binds a cursor to a specific file prefix. */
export interface RevisionPayload {
  version: 1;
  id: string;
  dev: string;
  ino: string;
  size: number;
  prefixHash: string;
}
