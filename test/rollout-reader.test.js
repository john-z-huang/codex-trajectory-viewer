import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RolloutReaderStore, ROLLOUT_INDEX_CACHE_MAX_FILES, ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES } from "../server-dist/rollout-reader.js";
import { subagentActivityFromRollout } from "../server-dist/subagents.js";
import { createAppServer } from "../server-dist/index.js";

async function createRolloutHome(t, prefix = "codex-viewer-reader-") {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const directory = path.join(home, "sessions", "2026", "10", "29");
  await mkdir(directory, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, directory };
}

async function listen(app) {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

function createDatabase(file, sql) {
  const database = new DatabaseSync(file);
  try { database.exec(sql); } finally { database.close(); }
}

test("bounded activity summary matches legacy cross-line path and status fallback", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "parent.jsonl");
  const contents = [
    JSON.stringify({ type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "child-1", agent_path: ["workers", "first"], kind: "started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "child-1" } }),
  ].join("\n") + "\n";
  await writeFile(file, contents);

  const reader = new RolloutReaderStore(home);
  const bounded = await reader.readWindow(file, 1);
  assert.deepEqual(bounded.activities, subagentActivityFromRollout(contents));
  assert.deepEqual(bounded.activities, [{ threadId: "child-1", agentPath: "workers/first", status: "started" }]);
});

test("window preserves physical lines, CRLF bytes, blank and malformed rows, null JSON, and an unterminated last line", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "physical-lines.jsonl");
  const rows = ["{\"n\":1}\r", "", "null", "{bad", "tail-without-lf"];
  const contents = rows.join("\n");
  await writeFile(file, contents);

  const reader = new RolloutReaderStore(home);
  const window = await reader.readWindow(file, 3);
  assert.equal(window.rollout.totalLines, rows.length);
  assert.equal(window.rollout.totalBytes, Buffer.byteLength(contents));
  assert.deepEqual(window.lines.map((line) => line.raw), rows);
  assert.deepEqual(window.lines.map((line) => line.byteLength), rows.map((row) => Buffer.byteLength(row)));
  assert.equal(window.lines.some((line) => line.oversized), false);
});

test("1k, 10k, and 50k short lines use fixed 32-line windows and bounded sparse indexes", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const reader = new RolloutReaderStore(home);

  for (const count of [1_000, 10_000, 50_000]) {
    const file = path.join(directory, `short-${count}.jsonl`);
    const contents = Array.from({ length: count }, (_, index) => JSON.stringify({ i: index })).join("\n") + "\n";
    await writeFile(file, contents);
    const window = await reader.readWindow(file, count);
    assert.equal(window.rollout.totalLines, count);
    assert.equal(window.rollout.totalBytes, Buffer.byteLength(contents));
    assert.equal(window.rollout.startLine, Math.floor((count - 1) / 32) * 32 + 1);
    assert.ok(window.lines.length <= 32);
    assert.ok(window.rollout.indexBytes <= ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES);
    assert.ok(window.rollout.indexStride >= 128);
  }

  const diagnostics = reader.getDiagnostics();
  assert.ok(diagnostics.cachedFiles <= ROLLOUT_INDEX_CACHE_MAX_FILES);
  assert.ok(diagnostics.logicalBytes <= ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES);
});

test("checkpoint compaction stays bounded past 524k physical lines and preserves page and raw line numbers", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "many-empty-lines.jsonl");
  const totalLines = 524_289;
  await writeFile(file, "\n".repeat(totalLines));
  const reader = new RolloutReaderStore(home);
  const window = await reader.readWindow(file, 524_250);

  assert.equal(window.rollout.totalLines, totalLines);
  assert.ok(window.rollout.indexStride > 128);
  assert.ok(window.rollout.indexBytes <= ROLLOUT_INDEX_CACHE_MAX_LOGICAL_BYTES);
  assert.equal(window.rollout.startLine, 524_225);
  assert.equal(window.lines[0].lineNumber, 524_225);
  assert.equal(window.lines.at(-1).lineNumber, 524_256);
  const raw = await reader.readRawChunk(file, window.rollout.revision, 524_250, 0);
  assert.equal(raw.lineNumber, 524_250);
  assert.equal(raw.byteLength, 0);
  assert.equal(raw.done, true);
});

test("a page caps raw UTF-8 fields at 2 MiB and bounds worst-case JSON escaping near 12 MiB", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "escaped-page.jsonl");
  const contents = Array.from({ length: 32 }, () => "\0".repeat(64 * 1024)).join("\n");
  await writeFile(file, contents);
  const reader = new RolloutReaderStore(home);
  const first = await reader.readWindow(file, 1);
  const page = await reader.readPage(file, first.rollout.revision, 1);
  const rawBytes = page.lines.reduce((total, line) => total + Buffer.byteLength(line.raw ?? ""), 0);
  const serializedBytes = Buffer.byteLength(JSON.stringify(page));

  assert.equal(rawBytes, 2 * 1024 * 1024);
  assert.ok(serializedBytes > rawBytes);
  assert.ok(serializedBytes <= rawBytes * 6 + 4 * 1024);
});

test("1 MiB and 10 MiB UTF-8 lines round-trip through bounded chunks and streamed downloads", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const reader = new RolloutReaderStore(home);

  for (const size of [1024 * 1024, 10 * 1024 * 1024]) {
    const file = path.join(directory, `large-${size}.jsonl`);
    const prefix = Buffer.alloc(16_383, 0x61);
    const multibyte = Buffer.from("🌈", "utf8");
    const suffix = Buffer.alloc(size - prefix.length - multibyte.length, 0x62);
    const expected = Buffer.concat([prefix, multibyte, suffix]);
    await writeFile(file, expected);

    const window = await reader.readWindow(file, 1);
    assert.equal(window.rollout.totalLines, 1);
    assert.equal(window.lines[0].byteLength, size);
    assert.equal(window.lines[0].oversized, true);
    assert.equal(Object.hasOwn(window.lines[0], "raw"), false);
    await assert.rejects(
      reader.readRawChunk(file, window.rollout.revision, 1, 16_384),
      (error) => error.status === 416 && error.code === "offset_not_utf8_boundary",
    );

    const pieces = [];
    let offset = 0;
    let calls = 0;
    while (true) {
      const chunk = await reader.readRawChunk(file, window.rollout.revision, 1, offset);
      assert.ok(Buffer.byteLength(chunk.raw) <= 16 * 1024);
      pieces.push(Buffer.from(chunk.raw, "utf8"));
      calls += 1;
      assert.ok(calls < 1_000);
      if (chunk.done) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    assert.deepEqual(Buffer.concat(pieces), expected);

    const streamed = [];
    for await (const bytes of reader.streamLine(file, window.rollout.revision, 1)) streamed.push(bytes);
    assert.deepEqual(Buffer.concat(streamed), expected);
  }
});

test("append keeps the original window readable; refresh includes new lines and historical changes still fail", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "mutable.jsonl");
  await writeFile(file, "one\ntwo\nthree\n");
  const reader = new RolloutReaderStore(home);
  const first = await reader.readWindow(file, 2);
  await appendFile(file, "four\n");
  const oldPage = await reader.readPage(file, first.rollout.revision, 2);
  assert.equal(oldPage.rollout.totalLines, 3);
  assert.deepEqual(oldPage.lines.map((line) => line.raw), ["one", "two", "three"]);
  const afterAppend = await reader.readWindow(file, 999);
  assert.equal(afterAppend.rollout.totalLines, 4);
  assert.equal(afterAppend.rollout.startLine, 1);
  assert.equal(afterAppend.lines.at(-1).raw, "four");

  const stableRevision = afterAppend.rollout.revision;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(file, "four\nthree\ntwo\none\n");
  await assert.rejects(reader.readPage(file, stableRevision, 1), (error) => error.status === 409);

  const replacementRevision = (await reader.readWindow(file, 1)).rollout.revision;
  const replacement = path.join(directory, "replacement.jsonl");
  await writeFile(replacement, "four\nthree\ntwo\none\n");
  await rename(replacement, file);
  await assert.rejects(reader.readPage(file, replacementRevision, 1), (error) => error.status === 409);

  const beforeTruncate = (await reader.readWindow(file, 1)).rollout.revision;
  await writeFile(file, "one\n");
  await assert.rejects(reader.readPage(file, beforeTruncate, 1), (error) => error.status === 409);
});

test("a historical rewrite during streamed line output fails after its first bounded chunk", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "stream-mutation.jsonl");
  await writeFile(file, "x".repeat(512 * 1024));
  const reader = new RolloutReaderStore(home);
  const window = await reader.readWindow(file, 1);
  const iterator = reader.streamLine(file, window.rollout.revision, 1)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.length, 64 * 1024);
  await writeFile(file, "y".repeat(512 * 1024));
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {}
  }, (error) => error.status === 409);
});

test("append-safe versions bound pages, search, raw chunks and streams even after index eviction", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "append-safe.jsonl");
  const tail = "尾".repeat(30_000);
  const original = Array.from({ length: 70 }, (_, i) => `old-${i + 1}`).join("\n") + "\n" + tail;
  await writeFile(file, original);
  const reader = new RolloutReaderStore(home);
  const initial = await reader.readWindow(file, 1);
  const revision = initial.rollout.revision;
  await appendFile(file, "tail-completed\nnew-only\n");
  const before = await readFile(file);
  // Reconstruct an evicted index from the self-contained version, with the
  // unterminated last line still ending at its original byte boundary.
  const freshReader = new RolloutReaderStore(home);
  const page = await freshReader.readPage(file, revision, 65);
  assert.equal(page.rollout.totalLines, 71);
  assert.equal(page.lines.at(-1).byteLength, Buffer.byteLength(tail));
  assert.equal((await freshReader.search(file, revision, "old-65", 0)).lineNumber, 65);
  assert.equal((await freshReader.search(file, revision, "new-only", 0)).lineNumber, null);
  let raw = "";
  let offset = 0;
  while (true) {
    const chunk = await freshReader.readRawChunk(file, revision, 71, offset);
    raw += chunk.raw;
    if (chunk.done) break;
    offset = chunk.nextOffset;
  }
  assert.equal(raw, tail);
  assert.deepEqual(await readFile(file), before, "page, search and raw reads leave the synthetic rollout unchanged");
  const streamed = [];
  for await (const chunk of freshReader.streamLine(file, revision, 71)) {
    streamed.push(chunk);
    await appendFile(file, "more-appended\n");
  }
  assert.equal(Buffer.concat(streamed).toString(), tail);
  assert.equal((await freshReader.readWindow(file, 999)).lines.at(-1).raw, "more-appended");
  assert.equal((await freshReader.readPage(file, revision, 33)).lines[0].raw, "old-33");
  assert.ok((await readFile(file)).subarray(0, before.length).equals(before));
  await writeFile(file, original.replace("old-1", "OLD-1") + "appended-again\n");
  await assert.rejects(freshReader.readPage(file, revision, 33), (error) => error.status === 409);
});

test("literal search spans read blocks but never crosses a physical line", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const file = path.join(directory, "search.jsonl");
  const query = Buffer.from("needle-cross-boundary");
  const prefix = Buffer.alloc(64 * 1024 - 5, 0x61);
  const suffix = Buffer.alloc(64 * 1024, 0x62);
  const contents = Buffer.concat([prefix, query, suffix, Buffer.from("\n"), Buffer.from("needle"), Buffer.from("\n")]);
  await writeFile(file, contents);

  const reader = new RolloutReaderStore(home);
  const window = await reader.readWindow(file, 1);
  assert.deepEqual(await reader.search(file, window.rollout.revision, query.toString(), 0), {
    revision: window.rollout.revision,
    lineNumber: 1,
  });
  assert.equal((await reader.search(file, window.rollout.revision, "cross-boundaryneedle", 0)).lineNumber, null);
  assert.equal((await reader.search(file, window.rollout.revision, "needle", 1)).lineNumber, 2);
});

test("index LRU stays within its file budget and aborts close active index builds", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const reader = new RolloutReaderStore(home);
  const files = [];
  for (let index = 0; index < ROLLOUT_INDEX_CACHE_MAX_FILES + 1; index += 1) {
    const file = path.join(directory, `cache-${index}.jsonl`);
    files.push(file);
    await writeFile(file, `row-${index}\n`);
    await reader.readWindow(file, 1);
  }
  const afterEviction = reader.getDiagnostics();
  assert.equal(afterEviction.cachedFiles, ROLLOUT_INDEX_CACHE_MAX_FILES);
  assert.ok(afterEviction.evictions >= 1);
  const buildsBefore = afterEviction.builds;
  await reader.readWindow(files[0], 1);
  assert.equal(reader.getDiagnostics().builds, buildsBefore + 1);

  const large = path.join(directory, "abort.jsonl");
  await writeFile(large, "x".repeat(2 * 1024 * 1024));
  const controller = new AbortController();
  const pending = reader.readWindow(large, 1, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("concurrent index construction stays within its fixed build limit", async (t) => {
  const { home, directory } = await createRolloutHome(t);
  const reader = new RolloutReaderStore(home);
  const contents = "x".repeat(1024 * 1024);
  const files = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const file = path.join(directory, `parallel-${index}.jsonl`);
    await writeFile(file, contents);
    return file;
  }));
  await Promise.all(files.map((file) => reader.readWindow(file, 1)));
  assert.ok(reader.getDiagnostics().maxConcurrentBuilds <= 2);
});

test("session window, page, raw, search, and download views stay bounded and use discovered IDs", async (t) => {
  const { home, directory } = await createRolloutHome(t, "codex-viewer-reader-api-");
  const sessionId = "reader-api-session";
  const sessionPath = path.join(directory, "parent.jsonl");
  const meta = { timestamp: "2026-10-29T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: "/synthetic/reader" } };
  const lines = [JSON.stringify(meta)];
  lines.push(JSON.stringify({ type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "child-api", agent_path: ["workers", "api"], kind: "started" } }));
  lines.push(JSON.stringify({ type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "child-api" } }));
  for (let index = 0; index < 39; index += 1) lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: `row-${index}` }] } }));
  lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "literal needle marker" }] } }));
  const contents = lines.join("\n") + "\n";
  await writeFile(sessionPath, contents);
  const statePath = path.join(home, "state_5.sqlite");
  const historyPath = path.join(home, "thread_history_1.sqlite");
  createDatabase(statePath, `CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, model TEXT, tokens_used INTEGER, source TEXT, archived INTEGER, updated_at_ms INTEGER); INSERT INTO threads VALUES ('${sessionId}', 'Synthetic window title', '/synthetic/reader', 'reader-test', 1, 'test', 0, 1793232000000);`);
  createDatabase(historyPath, `CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES ('${sessionId}', 'turn-1', 0); INSERT INTO thread_items VALUES ('${sessionId}', 'turn-1', 0);`);
  const filesBefore = new Map(await Promise.all([sessionPath, statePath, historyPath].map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));

  const app = createAppServer({ home });
  const base = await listen(app);
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  const session = sessions.find((item) => item.sessionId === sessionId);
  assert.ok(session);

  const windowResponse = await fetch(`${base}/api/sessions/${session.id}?view=window&line=42`);
  assert.equal(windowResponse.status, 200);
  const window = await windowResponse.json();
  assert.equal(Object.hasOwn(window, "contents"), false);
  assert.equal(window.title, "Synthetic window title");
  assert.equal(Array.isArray(window.supplement), true);
  assert.equal(window.rollout.totalLines, lines.length);
  assert.equal(window.rollout.startLine, 33);
  assert.equal(window.rollout.endLine, lines.length);
  assert.equal(Object.hasOwn(window.rollout, "warnings"), true);
  const activity = window.subagents.find((item) => item.threadId === "child-api");
  assert.equal(activity.agent.agentPath, "workers/api");
  assert.equal(activity.activityStatus, "started");

  const pageResponse = await fetch(`${base}/api/sessions/${session.id}?view=page&revision=${encodeURIComponent(window.rollout.revision)}&line=42`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.deepEqual(Object.keys(page).sort(), ["lines", "rollout"]);
  assert.equal(page.rollout.startLine, 33);

  const lastLine = lines.length;
  const rawResponse = await fetch(`${base}/api/sessions/${session.id}?view=raw&revision=${encodeURIComponent(window.rollout.revision)}&line=${lastLine}&offset=0`);
  assert.equal(rawResponse.status, 200);
  const raw = await rawResponse.json();
  assert.equal(raw.raw, lines.at(-1));
  assert.equal(raw.done, true);

  const searchResponse = await fetch(`${base}/api/sessions/${session.id}?view=search&revision=${encodeURIComponent(window.rollout.revision)}&q=needle&afterLine=40`);
  assert.equal(searchResponse.status, 200);
  assert.equal((await searchResponse.json()).lineNumber, lastLine);

  const downloadResponse = await fetch(`${base}/api/sessions/${session.id}?view=download&revision=${encodeURIComponent(window.rollout.revision)}&line=${lastLine}`);
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-type"), /^text\/plain; charset=utf-8$/);
  assert.match(downloadResponse.headers.get("content-disposition"), /^attachment; filename="rollout-line-\d+\.txt"$/);
  assert.equal(downloadResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), Buffer.from(lines.at(-1)));

  const denied = await fetch(`${base}/api/sessions/${Buffer.from("../../outside.jsonl").toString("base64url")}?view=window`);
  assert.equal(denied.status, 404);
  const ignoredPath = await fetch(`${base}/api/sessions/${session.id}?view=window&line=1&path=%2Fetc%2Fpasswd`);
  assert.equal(ignoredPath.status, 200);
  assert.equal(Object.hasOwn(await ignoredPath.json(), "contents"), false);
  for (const [file, hash] of filesBefore) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash);

  const invalidLine = await fetch(`${base}/api/sessions/${session.id}?view=page&revision=${encodeURIComponent(window.rollout.revision)}&line=0`);
  assert.equal(invalidLine.status, 400);
  await appendFile(sessionPath, "synthetic appended row\n");
  const oldPage = await fetch(`${base}/api/sessions/${session.id}?view=page&revision=${encodeURIComponent(window.rollout.revision)}&line=1`);
  assert.equal(oldPage.status, 200);
  assert.equal((await oldPage.json()).rollout.totalLines, lines.length);
  const oldSearch = await fetch(`${base}/api/sessions/${session.id}?view=search&revision=${encodeURIComponent(window.rollout.revision)}&q=appended&afterLine=0`);
  assert.equal((await oldSearch.json()).lineNumber, null);
  const oldRaw = await fetch(`${base}/api/sessions/${session.id}?view=raw&revision=${encodeURIComponent(window.rollout.revision)}&line=${lastLine}`);
  assert.equal((await oldRaw.json()).raw, lines.at(-1));
  const oldDownload = await fetch(`${base}/api/sessions/${session.id}?view=download&revision=${encodeURIComponent(window.rollout.revision)}&line=${lastLine}`);
  assert.equal(await oldDownload.text(), lines.at(-1));
  const refreshed = await fetch(`${base}/api/sessions/${session.id}?view=window&line=999`);
  const refreshedWindow = await refreshed.json();
  assert.equal(refreshedWindow.rollout.totalLines, lines.length + 1);
  assert.equal(refreshedWindow.lines.at(-1).raw, "synthetic appended row");
});

test("API literal search crosses 64 KiB read boundaries and downloads full 1 MiB and 10 MiB rows", async (t) => {
  const { home, directory } = await createRolloutHome(t, "codex-viewer-reader-large-api-");
  const query = Buffer.from("needle-cross-block");
  const fixtures = [];
  for (const [index, size] of [1024 * 1024, 10 * 1024 * 1024].entries()) {
    const sessionId = `large-reader-api-${index}`;
    const sessionPath = path.join(directory, `large-${index}.jsonl`);
    const metaLine = Buffer.from(JSON.stringify({ type: "session_meta", timestamp: "2026-10-29T00:00:00Z", payload: { id: sessionId } }));
    const row = Buffer.alloc(size, 0x61);
    if (index === 0) {
      const insertionOffset = 64 * 1024 - metaLine.length - 1 - 4;
      query.copy(row, insertionOffset);
    }
    const contents = Buffer.concat([metaLine, Buffer.from("\n"), row]);
    await writeFile(sessionPath, contents);
    fixtures.push({ sessionId, sessionPath, row, hash: createHash("sha256").update(contents).digest("hex") });
  }

  const app = createAppServer({ home });
  const base = await listen(app);
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  for (const fixture of fixtures) {
    const session = sessions.find((item) => item.sessionId === fixture.sessionId);
    assert.ok(session);
    const window = await (await fetch(`${base}/api/sessions/${session.id}?view=window&line=2`)).json();
    assert.equal(window.lines.length, 2);
    assert.equal(window.lines[1].byteLength, fixture.row.length);
    assert.equal(window.lines[1].oversized, true);
    assert.equal(Object.hasOwn(window.lines[1], "raw"), false);

    if (fixture.sessionId.endsWith("-0")) {
      const search = await fetch(`${base}/api/sessions/${session.id}?view=search&revision=${encodeURIComponent(window.rollout.revision)}&q=${encodeURIComponent(query.toString())}&afterLine=0`);
      assert.equal(search.status, 200);
      assert.equal((await search.json()).lineNumber, 2);
    }

    const download = await fetch(`${base}/api/sessions/${session.id}?view=download&revision=${encodeURIComponent(window.rollout.revision)}&line=2`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture.row);
    assert.equal(createHash("sha256").update(await readFile(fixture.sessionPath)).digest("hex"), fixture.hash);
  }
});
