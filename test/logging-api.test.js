import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../server-dist/index.js";
import { createAppLogger } from "../server-dist/logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_HTTP_EVENTS = new Set(["http_request_terminal", "http_request_failed", "http_request_aborted"]);
const LOGGER_INSTANCE_ID = "fedcba9876543210fedcba9876543210";

async function makeSandbox(t, { separateSqliteHome = false } = {}) {
  const tempRoot = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(tempRoot, "ctv-logging-api-test-"));
  const home = path.join(base, "codex-home");
  const sqliteHome = separateSqliteHome ? path.join(base, "sqlite-home") : home;
  await mkdir(home, { recursive: true });
  if (sqliteHome !== home) await mkdir(sqliteHome, { recursive: true });
  const environment = { base, home, sqliteHome, server: null, logger: null, databaseWriters: [] };
  t.after(async () => {
    if (environment.server?.listening) await new Promise((resolve) => environment.server.close(() => resolve()));
    for (const database of environment.databaseWriters) { try { database.close(); } catch { /* test cleanup */ } }
    if (environment.logger) await environment.logger.close();
    await rm(base, { recursive: true, force: true });
  });
  return environment;
}

function captureLogger({ minLevel = "debug", clock = () => new Date(2026, 9, 30, 12) } = {}) {
  const records = [];
  const serialized = [];
  const logger = createAppLogger({
    sink: {
      async write(record, line) {
        records.push(record);
        serialized.push(line);
      },
      async close() {},
    },
    instanceId: LOGGER_INSTANCE_ID,
    minLevel,
    clock,
    stderr: () => undefined,
  });
  return { logger, records, serialized };
}

async function startServer(environment, logger) {
  environment.logger = logger ?? null;
  const server = createAppServer({ home: environment.home, sqliteHome: environment.sqliteHome, logger });
  environment.server = server;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function browserEvent({ clientId = randomUUID(), eventId = randomUUID(), sequence = 1 } = {}) {
  return {
    event: "browser_tab",
    action: "open",
    tab_id: randomUUID(),
    operation_id: randomUUID(),
    client_id: clientId,
    event_id: eventId,
    client_time: "2026-10-30T12:00:00.000Z",
    client_seq: sequence,
  };
}

test("discovery aggregates safe skip reasons without recording paths or errors", async (t) => {
  const environment = await makeSandbox(t);
  const { logger, records, serialized } = captureLogger();
  const { base } = await startServer(environment, logger);
  assert.equal((await rawRequest(base, { pathname: "/api/sessions" })).status, 200);
  await waitFor(() => records.some((record) => record.event === "discovery_complete"), "missing directory summary");
  const first = records.find((record) => record.event === "discovery_complete");
  assert.equal(first.dirs_skipped, 2);
  assert.equal(first.missing_count, 2);
  assert.equal(first.unsafe_count, 0);
  await writeFile(path.join(environment.home, "sessions"), "PRIVATE_DISCOVERY_SENTINEL");
  assert.equal((await rawRequest(base, { pathname: "/api/sessions" })).status, 200);
  await waitFor(() => records.filter((record) => record.event === "discovery_complete").length === 2, "unsafe directory summary");
  const second = records.filter((record) => record.event === "discovery_complete")[1];
  assert.equal(second.dirs_skipped, 2);
  assert.equal(second.missing_count, 1);
  assert.equal(second.unsafe_count, 1);
  assert.equal(second.permission_count, 0);
  assert.equal(second.io_count, 0);
  assert.doesNotMatch(serialized.join(""), /PRIVATE_DISCOVERY_SENTINEL/);
  assert.equal(serialized.join("").includes(environment.home), false);
});

test("browser ingestion applies the global rolling limit across independent clients", async (t) => {
  const environment = await makeSandbox(t);
  let now = 0;
  let written = 0;
  const logger = createAppLogger({ sink: { write: async () => { written += 1; } }, monotonicNow: () => now });
  const { base } = await startServer(environment, logger);
  for (let client = 0; client < 10; client += 1) {
    const clientId = randomUUID();
    for (let batch = 0; batch < 6; batch += 1) {
      const result = await postEvents(base, Array.from({ length: 50 }, () => browserEvent({ clientId })));
      assert.equal(result.status, 200);
    }
  }
  assert.equal(written, 3000);
  assert.equal((await postEvents(base, [browserEvent()])).status, 429);
  assert.equal(written, 3000);
  now = 60_001;
  assert.equal((await postEvents(base, [browserEvent()])).status, 200);
  assert.equal(written, 3001);
});

test("an in-flight duplicate is not acknowledged as persisted until its write finishes", async (t) => {
  const environment = await makeSandbox(t);
  let release;
  let started = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const logger = createAppLogger({ sink: { write: async () => { started = true; await pending; } } });
  const { base } = await startServer(environment, logger);
  const event = browserEvent();
  const first = postEvents(base, [event]);
  try {
    await waitFor(() => started, "write starts");
    const duplicate = await postEvents(base, [event]);
    assert.equal(duplicate.status, 429);
    assert.equal(duplicate.json.persisted, false);
  } finally { release(); }
  assert.equal((await first).json.persisted, true);
  const final = await postEvents(base, [event]);
  assert.equal(final.status, 200);
  assert.equal(final.json.duplicate, 1);
});

test("a failed sink rejects persistence while session browsing and safe health remain available", async (t) => {
  const environment = await makeSandbox(t);
  const logger = createAppLogger({ sink: { write: async () => { throw new Error("PRIVATE_SINK_SENTINEL"); } }, stderr: () => {} });
  const { base } = await startServer(environment, logger);
  const rejected = await postEvents(base, [browserEvent()]);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.json.persisted, false);
  const listing = await rawRequest(base, { pathname: "/api/sessions" });
  assert.equal(listing.status, 200);
  const health = await rawRequest(base, { pathname: "/api/logs/health" });
  assert.equal(health.json.logging.healthy, false);
  assert.equal(health.json.logging.last_error_code, "log_write_failed");
  assert.doesNotMatch(JSON.stringify([rejected.json, health.json]), /PRIVATE_SINK_SENTINEL/);
});

test("an actual server failure emits one terminal error with a safe correlated diagnostic", async (t) => {
  const environment = await makeSandbox(t);
  const { logger, records, serialized } = captureLogger();
  const { base } = await startServer(environment, logger);
  const operationId = randomUUID();
  const response = await rawRequest(base, { pathname: "/%PRIVATE_URI_SENTINEL", headers: { "x-operation-id": operationId } });
  assert.equal(response.status, 500);
  await waitFor(() => records.some((record) => record.event === "http_request_failed"), "terminal error is written");
  const terminal = records.filter((record) => SERVER_HTTP_EVENTS.has(record.event));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].status, 500);
  assert.equal(terminal[0].operation_id, operationId);
  assert.ok(records.some((record) => record.event === "request_processing_error" && record.request_id === terminal[0].request_id));
  assert.doesNotMatch(serialized.join(""), /PRIVATE_URI_SENTINEL/);
});

function rawRequest(base, { method = "GET", pathname = "/", headers = {}, body, chunks } = {}) {
  const address = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: address.hostname,
      port: address.port,
      path: pathname,
      method,
      headers: { host: address.host, ...headers },
    }, (response) => {
      const parts = [];
      response.on("data", (part) => parts.push(part));
      response.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once("error", reject);
    if (chunks) {
      for (const chunk of chunks) request.write(chunk);
      request.end();
    } else if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function postEvents(base, events, { origin = base, host, contentType = "application/json" } = {}) {
  const headers = { origin, "content-type": contentType };
  if (host !== undefined) headers.host = host;
  return rawRequest(base, { method: "POST", pathname: "/api/logs", headers, body: JSON.stringify({ events }) });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function fileHash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function pathExists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function hashes(files) {
  const entries = await Promise.all(files.map(async (file) => [file, await fileHash(file)]));
  return Object.fromEntries(entries);
}

function createDatabase(file, setup) {
  const database = new DatabaseSync(file);
  try { setup(database); }
  finally { database.close(); }
}

async function correlatedGet(base, records, pathname, operationId, extraHeaders = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { "X-Operation-Id": operationId, ...extraHeaders },
  });
  const requestId = response.headers.get("x-request-id");
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  assert.match(requestId ?? "", UUID_RE, "server response must provide a fresh request ID");
  await waitFor(() => records.some((record) => SERVER_HTTP_EVENTS.has(record.event) && record.request_id === requestId), "HTTP request did not produce a terminal event");
  const terminal = records.filter((record) => SERVER_HTTP_EVENTS.has(record.event) && record.request_id === requestId);
  assert.equal(terminal.length, 1, "a request must produce exactly one terminal HTTP record");
  return { response, requestId, body, text, terminal: terminal[0] };
}

function assertCorrelation(result, { operationId, route, status, hasOperationId = true }) {
  assert.equal(result.response.status, status);
  assert.equal(result.terminal.route, route);
  assert.equal(result.terminal.status, status);
  assert.equal(result.terminal.request_id, result.requestId);
  if (hasOperationId) assert.equal(result.terminal.operation_id, operationId);
  else assert.equal(Object.hasOwn(result.terminal, "operation_id"), false);
}

async function createSessionFixture(home, { id, title, cwd, message, largeMessage } = {}) {
  const sessionRoot = path.join(home, "sessions", "2026", "10", "30");
  await mkdir(sessionRoot, { recursive: true });
  const rolloutPath = path.join(sessionRoot, "synthetic.jsonl");
  const records = [
    { timestamp: "2026-10-30T12:00:00.000Z", type: "session_meta", payload: { id, cwd, initial_user_message: title } },
    { timestamp: "2026-10-30T12:00:01.000Z", type: "event_msg", payload: { type: "user_message", message } },
  ];
  if (largeMessage) records.push({ timestamp: "2026-10-30T12:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: largeMessage } });
  await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return rolloutPath;
}

async function createHealthySqliteFixtures(home, sessionId, { query } = {}) {
  const statePath = path.join(home, "state_5.sqlite");
  createDatabase(statePath, (db) => {
    db.exec("CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT, model TEXT);");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(sessionId, "API synthetic title", "API synthetic title", "/synthetic/api-project", "fixture-model");
  });

  const historyPath = path.join(home, "thread_history_1.sqlite");
  createDatabase(historyPath, (db) => {
    db.exec("CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, summary TEXT);");
    db.exec("CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, item_json TEXT, content TEXT);");
    db.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?)").run(sessionId, "synthetic-turn-1", 1, "synthetic summary");
    db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run(
      sessionId,
      "synthetic-turn-1",
      1,
      JSON.stringify({ type: "agentMessage", text: query }),
      query,
    );
  });

  const goalsPath = path.join(home, "goals_1.sqlite");
  createDatabase(goalsPath, (db) => db.exec("CREATE TABLE thread_goals(thread_id TEXT, goal_id TEXT, content TEXT);"));
  return [statePath, historyPath, goalsPath];
}

test("POST /api/logs accepts allowlisted events once and health exposes only safe counters", async (t) => {
  const environment = await makeSandbox(t);
  const capture = captureLogger();
  const { base } = await startServer(environment, capture.logger);
  const clientId = randomUUID();
  const event = browserEvent({ clientId, eventId: randomUUID() });

  const first = await postEvents(base, [event]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { accepted: 1, duplicate: 0, rejected: 0, persisted: true });
  const duplicate = await postEvents(base, [event]);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.json, { accepted: 0, duplicate: 1, rejected: 0, persisted: true });

  const persisted = capture.records.filter((record) => record.event === "browser_tab" && record.event_id === event.event_id);
  assert.equal(persisted.length, 1, "a stable client event ID is persisted once");
  assert.equal(persisted[0].source, "browser");
  assert.equal(persisted[0].instance_id, LOGGER_INSTANCE_ID);
  assert.equal(persisted[0].client_id, clientId);
  assert.equal(persisted[0].operation_id, event.operation_id);
  assert.equal(persisted[0].tab_id, event.tab_id);
  assert.equal(Object.hasOwn(persisted[0], "request_id"), false, "the collector does not invent a client request ID");
  assert.match(persisted[0].time, /^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);

  const health = await fetch(`${base}/api/logs/health`).then((response) => response.json());
  assert.deepEqual(Object.keys(health.logging).sort(), ["dropped", "healthy", "last_error_code", "queued"]);
  assert.equal(health.logging.healthy, true);
  const healthText = JSON.stringify(health);
  assert.equal(healthText.includes(environment.home), false);
  assert.equal(healthText.includes(environment.base), false);
});

test("POST /api/logs rejects unsafe origin, host, content, envelope, IDs, server events, and oversized bodies", async (t) => {
  const environment = await makeSandbox(t);
  const capture = captureLogger();
  const { base } = await startServer(environment, capture.logger);
  const clientId = randomUUID();

  const invalidOrigin = await postEvents(base, [browserEvent({ clientId })], { origin: "http://attacker.invalid" });
  assert.equal(invalidOrigin.status, 403);
  assert.equal(invalidOrigin.json.code, "invalid_origin");

  const invalidHost = await postEvents(base, [browserEvent({ clientId })], { host: "attacker.invalid" });
  assert.equal(invalidHost.status, 403);
  assert.equal(invalidHost.json.code, "invalid_origin");

  const invalidType = await rawRequest(base, {
    method: "POST",
    pathname: "/api/logs",
    headers: { origin: base, "content-type": "text/plain" },
    body: JSON.stringify({ events: [browserEvent({ clientId })] }),
  });
  assert.equal(invalidType.status, 415);
  assert.equal(invalidType.json.code, "invalid_content_type");

  const invalidJson = await rawRequest(base, { method: "POST", pathname: "/api/logs", headers: { origin: base, "content-type": "application/json" }, body: "{" });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.code, "invalid_json");

  const extraEnvelope = await rawRequest(base, {
    method: "POST", pathname: "/api/logs", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ events: [browserEvent({ clientId })], private: "LOG_API_ENVELOPE_SENTINEL" }),
  });
  assert.equal(extraEnvelope.status, 400);
  assert.equal(extraEnvelope.json.code, "invalid_event");

  const unknownField = { ...browserEvent({ clientId }), title: "LOG_API_FIELD_SENTINEL" };
  const invalidFields = await postEvents(base, [unknownField]);
  assert.equal(invalidFields.status, 400);
  assert.equal(invalidFields.json.code, "invalid_event");

  const invalidId = { ...browserEvent({ clientId }), client_id: "LOG_API_BAD_UUID" };
  const invalidIds = await postEvents(base, [invalidId]);
  assert.equal(invalidIds.status, 400);
  assert.equal(invalidIds.json.code, "invalid_event");

  const forgedServerEvent = { ...browserEvent({ clientId }), event: "server_start" };
  const forged = await postEvents(base, [forgedServerEvent]);
  assert.equal(forged.status, 400);
  assert.equal(forged.json.code, "invalid_event");

  const tooMany = await postEvents(base, Array.from({ length: 51 }, (_, index) => browserEvent({ clientId, sequence: index + 1 })));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.code, "too_many_events");

  const tooLarge = await rawRequest(base, {
    method: "POST",
    pathname: "/api/logs",
    headers: { origin: base, "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
    body: " ".repeat(64 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.code, "payload_too_large");

  const chunkedTooLarge = await rawRequest(base, {
    method: "POST",
    pathname: "/api/logs",
    headers: { origin: base, "content-type": "application/json", "transfer-encoding": "chunked" },
    chunks: [Buffer.from('{"events":['), Buffer.alloc(66 * 1024, 0x20), Buffer.from("]}")],
  });
  assert.equal(chunkedTooLarge.status, 413, "chunked oversize body gets JSON 413 without Content-Length or socket reset");
  assert.equal(chunkedTooLarge.json.code, "payload_too_large");
  assert.equal(capture.records.length, 0, "rejected requests do not persist client records");
});

test("POST /api/logs enforces the 300 events per client rolling limit", async (t) => {
  const environment = await makeSandbox(t);
  const capture = captureLogger();
  const { base } = await startServer(environment, capture.logger);
  const clientId = randomUUID();
  let sequence = 1;
  let accepted = 0;

  for (let batch = 0; batch < 6; batch += 1) {
    const events = Array.from({ length: 50 }, () => browserEvent({ clientId, sequence: sequence++ }));
    const response = await postEvents(base, events);
    assert.equal(response.status, 200);
    assert.equal(response.json.accepted, 50);
    accepted += response.json.accepted;
  }
  const rateLimited = await postEvents(base, [browserEvent({ clientId, sequence })]);
  assert.equal(rateLimited.status, 429);
  assert.deepEqual(rateLimited.json, { accepted: 0, duplicate: 0, rejected: 1, persisted: false });
  assert.equal(accepted, 300);
  assert.equal(capture.records.filter((record) => record.source === "browser" && record.client_id === clientId).length, 300);
});

test("session list, window, history, search, and stale requests correlate without transcript values or mutating fixtures", async (t) => {
  const environment = await makeSandbox(t);
  const capture = captureLogger();
  const sessionId = "LOG_API_SESSION_ID_SENTINEL";
  const title = "LOG_API_TITLE_SENTINEL";
  const cwd = "/synthetic/LOG_API_CWD_SENTINEL";
  const query = "LOG_API_QUERY_SENTINEL";
  const rolloutPath = await createSessionFixture(environment.home, { id: sessionId, title, cwd, message: query });
  const databaseFiles = await createHealthySqliteFixtures(environment.home, sessionId, { query });
  const fixtureFiles = [rolloutPath, ...databaseFiles];
  const before = await hashes(fixtureFiles);
  const { base } = await startServer(environment, capture.logger);
  const operationId = randomUUID();
  const forgedRequestId = "LOG_API_FORGED_REQUEST_ID";

  const list = await correlatedGet(base, capture.records, "/api/sessions", operationId, { "X-Request-Id": forgedRequestId });
  assertCorrelation(list, { operationId, route: "sessions_list", status: 200 });
  assert.notEqual(list.requestId, forgedRequestId, "request IDs are generated by the server");
  const session = list.body.find((entry) => entry.sessionId === sessionId);
  assert.ok(session);
  assert.equal(session.title, "API synthetic title");
  const discovery = capture.records.find((record) => record.event === "discovery_complete" && record.request_id === list.requestId);
  assert.ok(discovery);
  assert.equal(discovery.operation_id, operationId);

  const opaqueId = encodeURIComponent(session.id);
  const window = await correlatedGet(base, capture.records, `/api/sessions/${opaqueId}?view=window&line=1`, operationId);
  assertCorrelation(window, { operationId, route: "sessions_window", status: 200 });
  assert.ok(window.body.rollout?.revision);
  const readerIndex = capture.records.find((record) => record.event === "reader_index" && record.request_id === window.requestId);
  assert.ok(readerIndex);
  assert.equal(readerIndex.operation_id, operationId);

  const supplementRevision = encodeURIComponent(window.body.supplementRevision);
  const history = await correlatedGet(base, capture.records, `/api/sessions/${opaqueId}?view=history&historyPage=1&supplementRevision=${supplementRevision}`, operationId);
  assertCorrelation(history, { operationId, route: "sessions_history", status: 200 });
  assert.equal(history.body.historyOnly, true);
  assert.equal(history.body.supplement.find((source) => source.database === "thread_history_1.sqlite").available, true);

  const search = await correlatedGet(base, capture.records, `/api/sessions/${opaqueId}?view=search&revision=${encodeURIComponent(window.body.rollout.revision)}&q=${encodeURIComponent(query)}&afterLine=0`, operationId);
  assertCorrelation(search, { operationId, route: "sessions_search", status: 200 });

  const historySearch = await correlatedGet(base, capture.records, `/api/sessions/${opaqueId}?view=history-search&supplementRevision=${supplementRevision}&q=${encodeURIComponent(query)}&afterIndex=0`, operationId);
  assertCorrelation(historySearch, { operationId, route: "sessions_history_search", status: 200 });
  assert.deepEqual(historySearch.body, { rowIndex: 1, page: 1, totalRows: 1 });

  const stale = await correlatedGet(base, capture.records, `/api/sessions/${opaqueId}?view=history-search&supplementRevision=forged&q=${encodeURIComponent(query)}&afterIndex=0`, operationId);
  assertCorrelation(stale, { operationId, route: "sessions_history_search", status: 409 });
  assert.equal(stale.terminal.classification, "expected_stale");
  assert.equal(stale.terminal.event, "http_request_terminal");
  assert.equal(capture.records.some((record) => record.event === "http_request_failed" && record.request_id === stale.requestId), false);
  const expectedStale = capture.records.find((record) => record.event === "expected_stale_snapshot" && record.request_id === stale.requestId);
  assert.ok(expectedStale);
  assert.equal(expectedStale.operation_id, operationId);

  const invalidOperation = await correlatedGet(base, capture.records, "/api/sessions", "LOG_API_INVALID_OPERATION_ID");
  assertCorrelation(invalidOperation, { operationId: undefined, route: "sessions_list", status: 200, hasOperationId: false });

  const logText = capture.serialized.join("");
  for (const privateValue of [sessionId, title, cwd, query, forgedRequestId]) assert.equal(logText.includes(privateValue), false, `${privateValue} must not be logged`);
  assert.deepEqual(await hashes(fixtureFiles), before, "all synthetic JSONL and SQLite fixtures remain unchanged after reads");
});

test("corrupt supplementary SQLite degrades with a stable warning while JSONL stays available and unchanged", async (t) => {
  const environment = await makeSandbox(t, { separateSqliteHome: true });
  const capture = captureLogger();
  const sessionId = "LOG_API_CORRUPT_SESSION_SENTINEL";
  const rolloutPath = await createSessionFixture(environment.home, {
    id: sessionId,
    title: "corrupt database synthetic title",
    cwd: "/synthetic/corrupt-project",
    message: "still available from JSONL",
  });
  const databasePath = path.join(environment.sqliteHome, "state_5.sqlite");
  createDatabase(databasePath, (db) => db.exec("CREATE TABLE threads(id TEXT, title TEXT);"));
  const corrupted = Buffer.from(await readFile(databasePath));
  corrupted.write("NOT_A_SQLITE_DB!", 0, "ascii");
  await writeFile(databasePath, corrupted);
  const fixtureFiles = [rolloutPath, databasePath];
  const before = await hashes(fixtureFiles);
  const { base } = await startServer(environment, capture.logger);

  const operationId = randomUUID();
  const list = await correlatedGet(base, capture.records, "/api/sessions", operationId);
  assertCorrelation(list, { operationId, route: "sessions_list", status: 200 });
  assert.equal(list.body.length, 1, "JSONL session list remains available when SQLite is corrupt");
  assert.equal(list.body[0].sessionId, sessionId);
  await waitFor(() => capture.records.some((record) => record.event === "sqlite_source_warning" && record.database === "state_5.sqlite"), "corrupt SQLite did not produce a safe source warning");
  const warning = capture.records.find((record) => record.event === "sqlite_source_warning" && record.database === "state_5.sqlite");
  assert.equal(warning.level, "warn");
  assert.equal(warning.error_code, "sqlite_corrupt");
  assert.equal(warning.state, "degraded");
  const logText = capture.serialized.join("");
  assert.equal(logText.includes("file is not a database"), false);
  assert.equal(logText.includes(sessionId), false);
  assert.deepEqual(await hashes(fixtureFiles), before, "JSONL and corrupt SQLite fixture remain unchanged");
});

test("read-only session API preserves genuine active WAL and shared-memory companion bytes", async (t) => {
  const environment = await makeSandbox(t, { separateSqliteHome: true });
  const capture = captureLogger();
  const sessionId = "LOG_API_WAL_SESSION_SENTINEL";
  const rolloutPath = await createSessionFixture(environment.home, {
    id: sessionId,
    title: "WAL synthetic title",
    cwd: "/synthetic/wal-project",
    message: "read-only WAL data",
  });
  const databasePath = path.join(environment.sqliteHome, "state_5.sqlite");
  const writer = new DatabaseSync(databasePath);
  environment.databaseWriters.push(writer);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT); ");
  writer.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(sessionId, "WAL title", "WAL title", "/synthetic/wal-project");
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  assert.equal(await pathExists(walPath), true);
  assert.equal(await pathExists(shmPath), true);
  const fixtureFiles = [rolloutPath, databasePath, walPath, shmPath];
  const before = await hashes(fixtureFiles);
  const { base } = await startServer(environment, capture.logger);

  const operationId = randomUUID();
  const list = await correlatedGet(base, capture.records, "/api/sessions", operationId);
  assertCorrelation(list, { operationId, route: "sessions_list", status: 200 });
  assert.equal(list.body[0].title, "WAL title");
  assert.deepEqual(await hashes(fixtureFiles), before, "the read-only API must not alter active SQLite WAL/SHM companions");
});

test("unconfigured server factory keeps logging disabled and does not create a log root", async (t) => {
  const environment = await makeSandbox(t);
  const sessionFile = await createSessionFixture(environment.home, {
    id: "LOG_API_DISABLED_SESSION",
    title: "disabled logger synthetic title",
    cwd: "/synthetic/disabled-project",
    message: "disabled logging fixture",
  });
  const before = await fileHash(sessionFile);
  const { base } = await startServer(environment, undefined);

  const health = await fetch(`${base}/api/logs/health`).then((response) => response.json());
  assert.deepEqual(health, { logging: { enabled: false, healthy: false, queued: 0, dropped: 0, last_error_code: null } });
  const disabled = await postEvents(base, [browserEvent()]);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.json.code, "log_write_failed");
  assert.equal(await fileHash(sessionFile), before);
  assert.equal((await readFile(sessionFile, "utf8")).includes("disabled logging fixture"), true);
  assert.equal(await pathExists(path.join(environment.home, ".local", "state", "codex-trajectory-viewer", "logs")), false);
});

test("a disconnected streamed download emits one HTTP terminal record without logging rollout text", async (t) => {
  const environment = await makeSandbox(t);
  const capture = captureLogger();
  const streamSecret = "LOG_API_STREAM_CONTENT_SENTINEL";
  const rolloutPath = await createSessionFixture(environment.home, {
    id: "LOG_API_STREAM_SESSION",
    title: "stream synthetic title",
    cwd: "/synthetic/stream-project",
    message: "first synthetic message",
    largeMessage: `${streamSecret}${"x".repeat(8 * 1024 * 1024)}`,
  });
  const before = await fileHash(rolloutPath);
  const { base } = await startServer(environment, capture.logger);
  const operationId = randomUUID();
  const list = await correlatedGet(base, capture.records, "/api/sessions", operationId);
  const session = list.body[0];
  const window = await correlatedGet(base, capture.records, `/api/sessions/${encodeURIComponent(session.id)}?view=window&line=1`, operationId);
  const revision = encodeURIComponent(window.body.rollout.revision);
  const streamResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}?view=download&revision=${revision}&line=3`, {
    headers: { "X-Operation-Id": operationId },
  });
  const requestId = streamResponse.headers.get("x-request-id");
  assert.match(requestId ?? "", UUID_RE);
  const reader = streamResponse.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  await reader.cancel();

  await waitFor(() => capture.records.some((record) => SERVER_HTTP_EVENTS.has(record.event) && record.request_id === requestId), "disconnected download did not emit a terminal HTTP record");
  const terminal = capture.records.filter((record) => SERVER_HTTP_EVENTS.has(record.event) && record.request_id === requestId);
  assert.equal(terminal.length, 1, "finish/close/error signals must be deduplicated into one terminal record");
  assert.equal(terminal[0].route, "sessions_download");
  assert.equal(terminal[0].operation_id, operationId);
  assert.equal(capture.serialized.join("").includes(streamSecret), false);
  assert.equal(await fileHash(rolloutPath), before, "streaming reads do not modify the rollout");
});
