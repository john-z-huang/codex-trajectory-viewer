import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer, discoverSessions } from "../server-dist/index.js";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

function createDatabase(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

test("会话列表 API 将 Guardian 标记为独立类型且不关联父会话目录", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-guardian-"));
  const sessionRoot = path.join(home, "sessions", "2026", "10", "15");
  await mkdir(sessionRoot, { recursive: true });
  const parentPath = path.join(sessionRoot, "parent.jsonl");
  const guardianPath = path.join(sessionRoot, "guardian.jsonl");
  await writeFile(parentPath, JSON.stringify({ type: "session_meta", payload: { id: "parent-thread", cwd: "/work/parent" } }) + "\n");
  await writeFile(guardianPath, JSON.stringify({ type: "session_meta", payload: {
    id: "guardian-thread",
    parent_thread_id: "parent-thread",
    thread_source: "guardian_review",
    source: { subagent: { other: "guardian" } },
  } }) + "\n");
  const app = createAppServer({ home });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(home, { recursive: true, force: true }); });

  const base = "http://127.0.0.1:" + app.address().port;
  const sessions = await (await fetch(base + "/api/sessions")).json();
  const guardian = sessions.find((session) => session.sessionId === "guardian-thread");

  assert.equal(guardian.guardian, true);
  assert.equal(guardian.agent, null);
  assert.equal(guardian.cwd, "");
  assert.equal(Object.hasOwn(guardian, "projectCwd"), false);
  assert.equal(Object.hasOwn(guardian, "isSubagent"), false);
});

test("仅发现 sessions / archived_sessions 下的 JSONL，并拒绝任意路径", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-"));
  const app = createAppServer({ home });
  await mkdir(path.join(home, "sessions", "2026", "01", "02"), { recursive: true });
  await mkdir(path.join(home, "archived_sessions"), { recursive: true });
  await mkdir(path.join(home, "outside"), { recursive: true });
  const activePath = path.join(home, "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  const archivedPath = path.join(home, "archived_sessions", "archived.jsonl");
  await writeFile(activePath, `${JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/demo", initial_user_message: "活动样例" } })}\n{bad\n`);
  await writeFile(archivedPath, `${JSON.stringify({ timestamp: "2025-01-01T00:00:00Z", type: "session_meta", payload: { id: "archived-id", cwd: "/synthetic/archive", initial_user_message: "归档样例" } })}\n`);
  await writeFile(path.join(home, "outside", "secret.jsonl"), "secret");
  const statePath = path.join(home, "state_5.sqlite");
  createDatabase(statePath, "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, model TEXT, tokens_used INTEGER, source TEXT, archived INTEGER, updated_at_ms INTEGER); INSERT INTO threads VALUES ('11111111-1111-4111-8111-111111111111', '合成 SQLite 标题', '/synthetic/repo', 'test-model', 128, 'cli', 0, 1767398400000);");
  const historyPath = path.join(home, "thread_history_1.sqlite");
  const historyRows = Array.from({ length: 53 }, (_, index) => `('11111111-1111-4111-8111-111111111111', 'turn-${index}', ${index})`).join(",");
  createDatabase(historyPath, `CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES ${historyRows}; INSERT INTO thread_items VALUES ${historyRows};`);
  const filesBefore = new Map(await Promise.all([activePath, archivedPath, statePath, historyPath].map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const address = app.address();
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const listResponse = await fetch(`${base}/api/sessions`);
  const sessions = await listResponse.json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.archived), true);
  assert.equal("_path" in sessions[0], false);
  assert.equal(sessions.find((session) => session.sessionId === "archived-id").cwd, "/synthetic/archive");
  const activeSummary = sessions.find((session) => session.sessionId === "11111111-1111-4111-8111-111111111111");
  assert.equal(activeSummary.title, "合成 SQLite 标题");
  assert.equal(activeSummary.cwd, "/synthetic/repo");
  assert.equal(activeSummary.model, "test-model");
  assert.equal(activeSummary.tokens_used, 128);
  assert.equal(activeSummary.source, "cli");
  assert.equal(activeSummary.archived, false);
  assert.equal(activeSummary.updatedAt, "2026-01-03T00:00:00.000Z");
  const historyProjectionResponse = await fetch(`${base}/api/sessions/${activeSummary.id}?view=history&historyPage=2`);
  assert.equal(historyProjectionResponse.status, 200);
  const historyProjection = await historyProjectionResponse.json();
  assert.deepEqual(Object.keys(historyProjection), ["supplement"]);
  assert.equal(historyProjection.supplement.length, 3);
  const projectedHistory = historyProjection.supplement.find((source) => source.database === "thread_history_1.sqlite")
    .tables.find((table) => table.table === "thread_turns");
  assert.deepEqual(projectedHistory.rows.map((row) => row.rollout_ordinal), [50, 51, 52]);
  const detail = await (await fetch(`${base}/api/sessions/${sessions[0].id}`)).json();
  assert.match(detail.contents, /\{bad/);
  assert.equal(detail.supplement.length, 3);
  assert.equal(detail.supplement.find((source) => source.database === "state_5.sqlite").tables[0].rows[0].title, "合成 SQLite 标题");
  const firstHistoryPage = detail.supplement.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_turns");
  assert.equal(firstHistoryPage.rows.length, 50);
  const nextDetail = await (await fetch(`${base}/api/sessions/${sessions[0].id}?historyPage=2`)).json();
  const secondHistoryPage = nextDetail.supplement.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_turns");
  assert.deepEqual(secondHistoryPage.rows.map((row) => row.rollout_ordinal), [50, 51, 52]);
  const denied = await fetch(`${base}/api/sessions/${encodeURIComponent(Buffer.from("../../outside/secret.jsonl").toString("base64url"))}?view=history`);
  assert.equal(denied.status, 404);
  for (const [file, hash] of filesBefore) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash, `${path.basename(file)} must remain unchanged`);
});

test("会话标题按 SQLite 与 rollout 候选字段优先级解析，列表和详情保持一致", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-titles-"));
  const sessionRoot = path.join(home, "sessions", "2026", "10", "15");
  await mkdir(sessionRoot, { recursive: true });
  const fixtures = [
    { id: "title-name", metadata: { name: "Rollout name", title: "Rollout title", initial_user_message: "Rollout initial" }, row: { name: "SQLite explicit name", title: "SQLite title", preview: "SQLite preview", first_user_message: "SQLite first message" } },
    { id: "title-db-title", metadata: { name: "Rollout name", title: "Rollout title" }, row: { name: "", title: "SQLite best effort title", preview: "SQLite preview", first_user_message: "SQLite first message" } },
    { id: "title-rollout-name", metadata: { name: "JSONL name", title: "JSONL title" }, row: { name: "", title: "", preview: "SQLite preview", first_user_message: "SQLite first message" } },
    { id: "title-preview", metadata: {}, row: { name: "", title: "", preview: "SQLite preview", first_user_message: "SQLite first message" } },
    { id: "title-first-user", metadata: { initial_user_message: "Rollout initial" }, row: { name: "", title: "", preview: "", first_user_message: "SQLite first user message" } },
    { id: "title-user-event", metadata: {}, row: null, userMessage: "First user message from rollout" },
    { id: "title-current-fallback", metadata: {}, row: null },
  ];
  const rolloutPaths = [];
  for (const fixture of fixtures) {
    const file = path.join(sessionRoot, `${fixture.id}.jsonl`);
    const records = [{ type: "session_meta", timestamp: "2026-10-15T00:00:00Z", payload: { id: fixture.id, cwd: "/synthetic/titles", ...fixture.metadata } }];
    if (fixture.userMessage) records.push({ type: "event_msg", timestamp: "2026-10-15T00:00:01Z", payload: { type: "user_message", message: fixture.userMessage } });
    await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    rolloutPaths.push(file);
  }
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const rows = fixtures.filter((fixture) => fixture.row).map((fixture) => `(${[fixture.id, fixture.row.name, fixture.row.title, fixture.row.preview, fixture.row.first_user_message].map(quote).join(", ")})`).join(",");
  const statePath = path.join(home, "state_5.sqlite");
  createDatabase(statePath, `CREATE TABLE threads(id TEXT, name TEXT, title TEXT, preview TEXT, first_user_message TEXT); INSERT INTO threads VALUES ${rows};`);
  const files = [...rolloutPaths, statePath];
  const hashesBefore = new Map(await Promise.all(files.map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const app = createAppServer({ home });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  const expectedTitles = new Map([
    ["title-name", "SQLite explicit name"],
    ["title-db-title", "SQLite best effort title"],
    ["title-rollout-name", "JSONL name"],
    ["title-preview", "SQLite preview"],
    ["title-first-user", "SQLite first user message"],
    ["title-user-event", "First user message from rollout"],
    ["title-current-fallback", "无用户消息预览"],
  ]);
  for (const [sessionId, title] of expectedTitles) {
    const session = sessions.find((item) => item.sessionId === sessionId);
    assert.equal(session.title, title, `${sessionId} should use its highest-priority title candidate`);
    const detail = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
    assert.equal(detail.title, title, `${sessionId} list and detail titles should match`);
  }
  for (const [file, hash] of hashesBefore) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash, `${path.basename(file)} must remain unchanged`);
});

test("不跟随指向 CODEX_HOME 内其他目录的 sessions 根符号链接", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-session-link-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const unrelated = path.join(home, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "unrelated" } })}\n`);
  await symlink(unrelated, path.join(home, "sessions"));
  assert.deepEqual(await discoverSessions(home), []);
});

test("在父会话中关联并读取子代理 rollout，缺失与冲突记录显示状态且不改写文件", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-subagents-"));
  const root = path.join(home, "sessions", "2026", "10", "15");
  await mkdir(root, { recursive: true });
  const parentThreadId = "parent-1111";
  const childThreadId = "22222222-2222-4222-8222-222222222222";
  const secondChildThreadId = "child-5555";
  const conflictedThreadId = "child-3333";
  const parentPath = path.join(root, "rollout-parent.jsonl");
  const childPath = path.join(root, `rollout-2026-10-15T00-00-01-${childThreadId}.jsonl`);
  const secondChildPath = path.join(root, "rollout-second-child.jsonl");
  const conflictPath = path.join(root, "rollout-conflict.jsonl");
  const parentContents = [
    { timestamp: "2026-10-15T00:00:00Z", type: "session_meta", payload: { id: parentThreadId, cwd: "/synthetic/project", initial_user_message: "Parent conversation title" } },
    { timestamp: "2026-10-15T00:01:00Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: childThreadId, agent_path: ["research"], kind: "completed" } },
    { timestamp: "2026-10-15T00:02:00Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "missing-4444", agent_path: ["missing"], kind: "started" } },
    { timestamp: "2026-10-15T00:03:00Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: conflictedThreadId, agent_path: ["conflict"], kind: "started" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const secondChildContents = [
    { timestamp: "2026-10-15T00:00:04Z", type: "session_meta", payload: { id: secondChildThreadId, parent_thread_id: parentThreadId, source: "vscode", agent_path: ["writer"] } },
    { timestamp: "2026-10-15T00:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "第二个子代理合成内容" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const childContents = [
    { timestamp: "2026-10-15T00:00:01Z", type: "session_meta", payload: { id: childThreadId, parent_thread_id: parentThreadId, source: { sub_agent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: ["research"] } } }, agent_nickname: "Bluebird", agent_role: "explorer", cwd: "/synthetic/project" } },
    { timestamp: "2026-10-15T00:00:01.500Z", type: "session_meta", payload: { id: parentThreadId, cwd: "/synthetic/parent", initial_user_message: "Later parent metadata must not replace child identity" } },
    { timestamp: "2026-10-15T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "子代理合成执行内容" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n损坏的合成子代理行\n";
  const conflictContents = [
    { timestamp: "2026-10-15T00:00:03Z", type: "session_meta", payload: { id: conflictedThreadId, parent_thread_id: "different-parent", source: { sub_agent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: ["conflict"] } } } } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  await Promise.all([
    writeFile(parentPath, parentContents),
    writeFile(childPath, childContents),
    writeFile(secondChildPath, secondChildContents),
    writeFile(conflictPath, conflictContents),
  ]);
  const originalHashes = new Map(await Promise.all([parentPath, childPath, secondChildPath, conflictPath].map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const app = createAppServer({ home });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  const parent = sessions.find((session) => session.sessionId === parentThreadId);
  const child = sessions.find((session) => session.sessionId === childThreadId);
  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.sessionId, childThreadId);
  assert.equal(child.agent.agentPath, "research");
  assert.equal(child.agent.parentThreadId, parentThreadId);
  assert.equal(child.agent.parentSessionId, parent.id);
  assert.equal(child.agent.parentTitle, "Parent conversation title");
  assert.equal(child.cwd, "/synthetic/project");
  const secondChild = sessions.find((session) => session.sessionId === secondChildThreadId);
  assert.equal(secondChild.cwd, "");
  assert.equal(secondChild.projectCwd, "/synthetic/project");

  const detail = await (await fetch(`${base}/api/sessions/${parent.id}`)).json();
  const childLink = detail.subagents.find((item) => item.threadId === childThreadId);
  assert.equal(childLink.available, true);
  assert.equal(childLink.id, child.id);
  assert.equal(childLink.agent.nickname, "Bluebird");
  assert.equal(childLink.activityStatus, "completed");
  const secondChildLink = detail.subagents.find((item) => item.threadId === secondChildThreadId);
  assert.equal(secondChildLink.available, true);
  assert.equal(secondChildLink.agent.agentPath, "writer");
  const missingLink = detail.subagents.find((item) => item.threadId === "missing-4444");
  assert.equal(missingLink.available, false);
  assert.match(missingLink.reason, /没有发现可读取/);
  const conflictLink = detail.subagents.find((item) => item.threadId === conflictedThreadId);
  assert.equal(conflictLink.available, false);
  assert.match(conflictLink.reason, /标识不一致/);

  const childDetailResponse = await fetch(`${base}/api/sessions/${childLink.id}`);
  assert.equal(childDetailResponse.status, 200);
  const childDetail = await childDetailResponse.json();
  assert.match(childDetail.contents, /子代理合成执行内容/);
  assert.match(childDetail.contents, /损坏的合成子代理行/);
  assert.equal((await fetch(`${base}/api/sessions/${encodeURIComponent(Buffer.from("../../outside/secret.jsonl").toString("base64url"))}`)).status, 404);
  for (const [file, hash] of originalHashes) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash);
});

test("SQLite 历史绑定窗口版本，WAL 中的新内容必须显式刷新才能加载", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-manual-refresh-'));
  await mkdir(path.join(home, 'sessions'));
  await writeFile(path.join(home, 'sessions', 'synthetic.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-thread' } }) + '\n');
  const file = path.join(home, 'thread_history_1.sqlite');
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT); INSERT INTO thread_turns VALUES ('synthetic-thread', 'old');");
  const app = createAppServer({ home });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); writer.close(); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const [session] = await (await fetch(`${base}/api/sessions`)).json();
  const endpoint = `${base}/api/sessions/${session.id}`;
  const initial = await (await fetch(`${endpoint}?view=window`)).json();
  assert.match(initial.supplementRevision, /^[a-f0-9]{64}$/);
  const historyUrl = `${endpoint}?view=history&historyPage=1&supplementRevision=${initial.supplementRevision}`;
  assert.equal((await fetch(historyUrl)).status, 200);
  writer.exec("INSERT INTO thread_turns VALUES ('synthetic-thread', 'new');");
  const before = await readFile(file);
  const walBefore = await readFile(`${file}-wal`);
  const rejected = await fetch(historyUrl);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'stale_revision');
  const refreshed = await (await fetch(`${endpoint}?view=window`)).json();
  assert.notEqual(refreshed.supplementRevision, initial.supplementRevision);
  assert.equal((await fetch(`${endpoint}?view=history&supplementRevision=${refreshed.supplementRevision}`)).status, 200);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(`${file}-wal`), walBefore, 'viewer does not write the synthetic WAL');
});
