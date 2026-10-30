import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const ALLOWED_SQLITE_DATABASES = Object.freeze([
  "state_5.sqlite",
  "thread_history_1.sqlite",
  "goals_1.sqlite",
] as const);

const SNAPSHOT_NAMESPACE = "codex-trajectory-viewer-sqlite-snapshots";
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_CONCURRENT_SNAPSHOTS = 2;
const MAX_QUEUED_SNAPSHOTS = 8;

let activeSnapshotJobs = 0;
const snapshotWaiters: Array<() => void> = [];

export interface SQLiteSnapshotOptions {
  /** Effective CODEX_HOME selected by createAppServer. */
  codexHome: string;
  /** Effective CODEX_SQLITE_HOME selected by createAppServer. */
  sqliteHome: string;
  /** Existing temporary parent. Defaults to os.tmpdir(). */
  tempRoot?: string;
  /** Optional test override for the default log root protected by the helper. */
  defaultLogRoot?: string;
  /** Additional configured roots that must not overlap the private namespace. */
  additionalProtectedRoots?: Array<string | undefined>;
  /** Test control; production retries are capped at four attempts. */
  maxAttempts?: number;
}

export interface SQLiteSourceIdentity {
  dev: string;
  ino: string;
  token: string;
}

interface FileFingerprint {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: string;
  nlink: string;
}

interface SourceFingerprint {
  main: FileFingerprint;
  wal: FileFingerprint | null;
  journal: FileFingerprint | null;
}

function snapshotError(code: string, message = "SQLite snapshot unavailable"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function snapshotSlotRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSnapshotJobs -= 1;
    snapshotWaiters.shift()?.();
  };
}

async function acquireSnapshotSlot(): Promise<() => void> {
  if (activeSnapshotJobs < MAX_CONCURRENT_SNAPSHOTS) {
    activeSnapshotJobs += 1;
    return snapshotSlotRelease();
  }
  if (snapshotWaiters.length >= MAX_QUEUED_SNAPSHOTS) {
    throw snapshotError("SQLITE_BUSY", "SQLite snapshot capacity is busy");
  }
  return new Promise((resolve) => {
    snapshotWaiters.push(() => {
      activeSnapshotJobs += 1;
      resolve(snapshotSlotRelease());
    });
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
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
      const resolved = await realpath(candidate);
      return path.resolve(resolved, ...suffix.reverse());
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw snapshotError(code ?? "EACCES", "SQLite snapshot path is unavailable");
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function safeNamespace(options: SQLiteSnapshotOptions): Promise<string> {
  const configuredTempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  let tempParent: string;
  try { tempParent = await realpath(configuredTempRoot); }
  catch (error) { throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory is unavailable"); }
  const parentInfo = await lstat(tempParent, { bigint: true }).catch((error) => {
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory is unavailable");
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw snapshotError("EACCES", "SQLite snapshot directory is unsafe");

  const namespace = path.join(tempParent, SNAPSHOT_NAMESPACE);
  const existingNamespace = await lstat(namespace, { bigint: true }).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory is unavailable");
  });
  if (existingNamespace && (!existingNamespace.isDirectory() || existingNamespace.isSymbolicLink())) {
    throw snapshotError("EACCES", "SQLite snapshot directory is unsafe");
  }

  const defaultLogRoot = options.defaultLogRoot ?? path.join(os.homedir(), ".local", "state", "codex-trajectory-viewer", "logs");
  const protectedRoots = [
    options.codexHome,
    options.sqliteHome,
    process.env.CODEX_HOME,
    process.env.CODEX_SQLITE_HOME,
    defaultLogRoot,
    ...(options.additionalProtectedRoots ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const resolvedNamespace = await resolveThroughMissing(namespace);
  for (const root of protectedRoots) {
    const resolvedRoot = await resolveThroughMissing(root);
    if (overlaps(resolvedNamespace, resolvedRoot)) throw snapshotError("EACCES", "SQLite snapshot directory overlaps a protected root");
  }

  if (existingNamespace && typeof process.getuid === "function" && existingNamespace.uid !== BigInt(process.getuid())) {
    throw snapshotError("EACCES", "SQLite snapshot directory is not owned by this user");
  }
  return namespace;
}

async function ensurePrivateNamespace(namespace: string): Promise<void> {
  await mkdir(namespace, { mode: 0o700 }).catch((error) => {
    if (errorCode(error) !== "EEXIST") throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory is unavailable");
  });
  const info = await lstat(namespace, { bigint: true }).catch((error) => {
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory is unavailable");
  });
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid()))) {
    throw snapshotError("EACCES", "SQLite snapshot directory is unsafe");
  }
  if ((info.mode & 0o777n) !== 0o700n) await chmod(namespace, 0o700).catch((error) => {
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory cannot be made private");
  });
}

async function fingerprintFile(filePath: string, sourceRoot: string, optional: boolean): Promise<FileFingerprint | null> {
  let info;
  try { info = await lstat(filePath, { bigint: true }); }
  catch (error) {
    if (optional && errorCode(error) === "ENOENT") return null;
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite source file is unavailable");
  }
  if (info.isSymbolicLink()) throw snapshotError("SQLITE_CANTOPEN", "SQLite source file escapes CODEX_SQLITE_HOME");
  if (!info.isFile()) throw snapshotError("SQLITE_CANTOPEN", "SQLite source file is not a regular file");
  const resolved = await realpath(filePath).catch((error) => {
    throw snapshotError(errorCode(error) ?? "SQLITE_CANTOPEN", "SQLite source file is unavailable");
  });
  if (path.dirname(resolved) !== sourceRoot) throw snapshotError("SQLITE_CANTOPEN", "SQLite source file escapes CODEX_SQLITE_HOME");
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
    mode: String(info.mode),
    nlink: String(info.nlink),
  };
}

async function sourceFingerprint(sourceRoot: string, filename: string): Promise<SourceFingerprint> {
  const main = await fingerprintFile(path.join(sourceRoot, filename), sourceRoot, false);
  if (!main) throw snapshotError("ENOENT", "SQLite database is not present");
  const wal = await fingerprintFile(path.join(sourceRoot, `${filename}-wal`), sourceRoot, true);
  const journal = await fingerprintFile(path.join(sourceRoot, `${filename}-journal`), sourceRoot, true);
  if (journal && BigInt(journal.size) > 0n) throw snapshotError("SQLITE_BUSY", "SQLite source has an active rollback journal");
  return { main, wal, journal };
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceIdentity(main: FileFingerprint): SQLiteSourceIdentity {
  const token = createHash("sha256").update(`${main.dev}:${main.ino}`).digest("hex");
  return { dev: main.dev, ino: main.ino, token };
}

function cloneUnsupported(error: unknown): boolean {
  return ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOTTY"].includes(errorCode(error) ?? "");
}

async function copyPrivate(source: string, destination: string): Promise<void> {
  const exclusive = constants.COPYFILE_EXCL;
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE | exclusive);
  } catch (error) {
    if (!cloneUnsupported(error)) throw snapshotError(errorCode(error) ?? "SQLITE_CANTOPEN", "SQLite snapshot copy failed");
    await unlink(destination).catch((removeError) => {
      if (errorCode(removeError) !== "ENOENT") throw snapshotError(errorCode(removeError) ?? "EACCES", "SQLite snapshot copy failed");
    });
    await copyFile(source, destination, exclusive).catch((copyError) => {
      throw snapshotError(errorCode(copyError) ?? "SQLITE_CANTOPEN", "SQLite snapshot copy failed");
    });
  }
  await chmod(destination, 0o600).catch((error) => {
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot file cannot be made private");
  });
  const info = await lstat(destination, { bigint: true }).catch((error) => {
    throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot copy is unavailable");
  });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n
    || (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid()))) {
    throw snapshotError("EACCES", "SQLite snapshot copy is unsafe");
  }
}

/**
 * Read an allowlisted SQLite database from a private main-file/WAL snapshot.
 * SQLite opens only the copy; its SHM coordination file is confined to the
 * private snapshot directory and removed after the callback has closed SQLite.
 */
export async function withSQLiteSnapshot<T>(
  filename: string,
  options: SQLiteSnapshotOptions,
  read: (snapshotDatabasePath: string, identity: SQLiteSourceIdentity) => T | Promise<T>,
): Promise<{ value: T; identity: SQLiteSourceIdentity }> {
  if (!(ALLOWED_SQLITE_DATABASES as readonly string[]).includes(filename)) {
    throw snapshotError("SQLITE_CANTOPEN", "SQLite database is not allowlisted");
  }

  const releaseSnapshotSlot = await acquireSnapshotSlot();
  try {
    return await createSQLiteSnapshot(filename, options, read);
  } finally {
    releaseSnapshotSlot();
  }
}

async function createSQLiteSnapshot<T>(
  filename: string,
  options: SQLiteSnapshotOptions,
  read: (snapshotDatabasePath: string, identity: SQLiteSourceIdentity) => T | Promise<T>,
): Promise<{ value: T; identity: SQLiteSourceIdentity }> {
  if (!(ALLOWED_SQLITE_DATABASES as readonly string[]).includes(filename)) {
    throw snapshotError("SQLITE_CANTOPEN", "SQLite database is not allowlisted");
  }

  const namespace = await safeNamespace(options);
  await ensurePrivateNamespace(namespace);
  const sourceRoot = await realpath(options.sqliteHome).catch((error) => {
    throw snapshotError(errorCode(error) ?? "ENOENT", "SQLite source root is unavailable");
  });
  const configuredAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, Math.min(4, Number.isSafeInteger(configuredAttempts) ? configuredAttempts : DEFAULT_MAX_ATTEMPTS));
  let sawSourceChange = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await sourceFingerprint(sourceRoot, filename);
    const snapshotDirectory = await mkdtemp(path.join(namespace, "snapshot-"))
      .catch((error) => { throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory could not be created"); });
    try {
      await chmod(snapshotDirectory, 0o700).catch((error) => {
        throw snapshotError(errorCode(error) ?? "EACCES", "SQLite snapshot directory cannot be made private");
      });
      const snapshotDatabasePath = path.join(snapshotDirectory, filename);
      try {
        await copyPrivate(path.join(sourceRoot, filename), snapshotDatabasePath);
        if (before.wal) await copyPrivate(path.join(sourceRoot, `${filename}-wal`), `${snapshotDatabasePath}-wal`);
      } catch (error) {
        const afterCopy = await sourceFingerprint(sourceRoot, filename);
        if (!sameFingerprint(before, afterCopy)) { sawSourceChange = true; continue; }
        throw error;
      }

      const afterCopy = await sourceFingerprint(sourceRoot, filename);
      if (!sameFingerprint(before, afterCopy)) { sawSourceChange = true; continue; }

      const identity = sourceIdentity(before.main);
      let value: T;
      try { value = await read(snapshotDatabasePath, identity); }
      catch (error) {
        const afterRead = await sourceFingerprint(sourceRoot, filename);
        if (!sameFingerprint(before, afterRead)) { sawSourceChange = true; continue; }
        throw error;
      }
      const afterRead = await sourceFingerprint(sourceRoot, filename);
      if (!sameFingerprint(before, afterRead)) { sawSourceChange = true; continue; }
      return { value, identity };
    } finally {
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (sawSourceChange) throw snapshotError("SQLITE_BUSY", "SQLite source changed during snapshot read");
  throw snapshotError("SQLITE_CANTOPEN", "SQLite snapshot could not be read");
}
